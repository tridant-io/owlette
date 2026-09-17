"""a dead process must never keep reading green.

THE BUG (reported 2026-09-12, reproduced from this machine's service.log):
close a managed app by hand, then switch its launch mode to off before the
5-second loop next looks at it, and the desktop dot stays green on a process
that is gone.

THE MECHANISM, which is one rung up from where it looks: the service writes a
status when it LAUNCHES a process and when it deliberately stops one, and never
when a process dies on its own. The stale RUNNING row is normally superseded by
the RELAUNCH's new row -- so the row is only ever corrected as a side effect of
relaunching. Remove the relaunch and nothing corrects it. Switching the mode to
off is one way to remove it; an exhausted attempt count and a scheduled entry
that has left its window are others, and neither involves a launch-mode change
at all. handle_process's dead-pid branch (the `else` under
`if last_pid and Util.is_pid_running(last_pid)`) is where the service KNOWS the
pid is dead, so that is where the row is retired.

The freeze was bounded at five minutes by cleanup_stale_tracking_data -- except
when Windows recycled the pid, because that sweep gated on bare
psutil.pid_exists with no identity check, and any unrelated process inheriting
the number kept the row alive forever. _pid_still_ours closes that.

NEGATIVE CONTROLS (repo rule -- a guard that never failed proves nothing).
These three FAIL against the pre-fix owlette_service.py:
  - test_running_row_is_retired_when_the_mode_goes_off_mid_tick
  - test_running_row_is_retired_when_the_relaunch_is_skipped_by_schedule
  - test_sweep_drops_a_row_whose_pid_was_recycled
The keep tests (RESTARTING, KILLED, live pid, no identity record) pass both
before and after: they pin what the fix must NOT disturb.

House patterns: real OwletteService method bodies descriptor-bound onto a
SimpleNamespace, FakeProc + a monkeypatched psutil process table, and a
redirected state file -- all from test_launch_failed.py, which is the closest
analogue. owlette_service is imported lazily inside tests so collection order
cannot double-initialise the cryptography PyO3 bindings.
"""

import contextlib
import datetime
import json
from types import SimpleNamespace

import psutil
import pytest

import shared_utils


ENTRY_ID = 'proc-1'
EXE = 'c:\\apps\\demo.exe'
PID = 4242
CREATE_TIME = 1111.5

ENTRY = {'id': ENTRY_ID, 'name': 'Moonshine Server', 'exe_path': EXE,
         'file_path': '', 'launch_mode': 'always', 'time_to_init': 0}


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


def install_config(monkeypatch, launch_mode, schedules=None):
    """read_config as handle_process's fresh re-read will see it."""
    entry = dict(ENTRY, launch_mode=launch_mode)
    if schedules is not None:
        entry['schedules'] = schedules

    def fake_read_config(keys=None, process_list_id=None):
        cfg = {'processes': [entry], 'firebase': {'enabled': False}}
        if keys == ['processes']:
            return cfg['processes']
        if keys == ['time_to_init']:
            return '0'
        return cfg

    monkeypatch.setattr(shared_utils, 'read_config', fake_read_config)
    return entry


def write_states(path, states):
    path.write_text(json.dumps(states))


def read_states(path):
    if not path.exists():
        return {}
    return json.loads(path.read_text())


def row(status='RUNNING', create_time=CREATE_TIME, exe=EXE, timestamp=100):
    """An app_states row as the launch path records one."""
    built = {'id': ENTRY_ID, 'status': status, 'timestamp': timestamp,
             'exe': exe, 'managed': True, 'origin': 'launched'}
    if create_time is not None:
        built['create_time'] = create_time
    return built


def make_service(results, *, shutting_down=False):
    """A service double carrying the real handle_process body."""
    from owlette_service import OwletteService
    svc = SimpleNamespace(
        install_locks={},
        last_started={ENTRY_ID: {'pid': PID,
                                 'time': datetime.datetime(2020, 1, 1)}},
        relaunch_attempts={},
        manual_overrides={},
        first_start=False,
        _shutting_down=shutting_down,
        _cached_site_timezone=None,
        current_time=datetime.datetime(2026, 9, 12, 1, 36),
        firebase_client=None,
        results=results,
        _write_cortex_event=lambda *a, **k: None,
        _capture_crash_screenshot=lambda: None,
    )
    svc.handle_process = OwletteService.handle_process.__get__(
        svc, OwletteService)
    return svc


def make_cleanup_service(results):
    from owlette_service import OwletteService
    svc = SimpleNamespace(
        last_started={},
        relaunch_attempts={},
        install_locks={},
        active_installations={},
        manual_overrides={},
        _skip_launch_delay=set(),
        results=results,
    )
    svc.cleanup_stale_tracking_data = (
        OwletteService.cleanup_stale_tracking_data.__get__(svc, OwletteService))
    return svc


# ==========================================================================
# retiring the row where the death is observed
# ==========================================================================

def test_running_row_is_retired_when_the_mode_goes_off_mid_tick(
        state_file, monkeypatch):
    """THE REPORTED BUG. The user closes the app, then flips the mode to off
    before the loop looks. handle_process finds the pid dead, re-reads the
    config, sees 'off' and declines to relaunch -- so nothing supersedes the
    RUNNING row, and both UIs keep the entry green.

    NEGATIVE CONTROL: fails against the pre-fix service, which leaves the row.
    """
    write_states(state_file, {str(PID): row('RUNNING')})
    install_process_table(monkeypatch, {})          # the pid is dead
    entry = install_config(monkeypatch, 'off')      # ...and the mode is now off
    svc = make_service(json.loads(state_file.read_text()))

    svc.handle_process(dict(entry, launch_mode='always'))

    assert str(PID) not in read_states(state_file), (
        'a row claiming RUNNING outlived the pid it names')
    assert str(PID) not in svc.results, (
        'the in-memory snapshot still holds the row; '
        'cleanup_stale_tracking_data writes it back wholesale later in '
        'this same tick and would restore it')


def test_running_row_is_retired_when_the_relaunch_is_skipped_by_schedule(
        state_file, monkeypatch):
    """The same freeze with no launch-mode change at all: a scheduled entry
    whose window has closed takes the identical no-relaunch bail.

    NEGATIVE CONTROL: fails against the pre-fix service.
    """
    write_states(state_file, {str(PID): row('RUNNING')})
    install_process_table(monkeypatch, {})
    # An empty schedule list is outside every window.
    entry = install_config(monkeypatch, 'scheduled', schedules=[])
    monkeypatch.setattr(shared_utils, 'is_within_schedule',
                        lambda schedules, tz=None: False)
    svc = make_service(json.loads(state_file.read_text()))

    svc.handle_process(dict(entry, launch_mode='scheduled'))

    assert str(PID) not in read_states(state_file)


def test_launching_row_is_retired_too(state_file, monkeypatch):
    """LAUNCHING claims life as much as RUNNING does -- a process that dies
    inside its init window must not be left mid-launch forever."""
    write_states(state_file, {str(PID): row('LAUNCHING')})
    install_process_table(monkeypatch, {})
    entry = install_config(monkeypatch, 'off')
    svc = make_service(json.loads(state_file.read_text()))

    svc.handle_process(dict(entry, launch_mode='always'))

    assert str(PID) not in read_states(state_file)


# ==========================================================================
# what the fix must NOT disturb
# ==========================================================================

def test_restarting_marker_survives(state_file, monkeypatch):
    """RESTARTING is load-bearing, not a stale claim: _relaunch_if_restarting
    reads it to honour an operator restart of a process whose mode is off.
    Retiring it would turn that restart into a silent stop."""
    write_states(state_file, {str(PID): row('RESTARTING')})
    install_process_table(monkeypatch, {})
    entry = install_config(monkeypatch, 'off')
    svc = make_service(json.loads(state_file.read_text()))

    svc.handle_process(dict(entry, launch_mode='always'))

    assert read_states(state_file)[str(PID)]['status'] == 'RESTARTING'


def test_killed_row_survives(state_file, monkeypatch):
    """KILLED is already terminal and already renders as not-live. Nothing to
    correct, and the row is what tells the next tick the exit was intended."""
    write_states(state_file, {str(PID): row('KILLED')})
    install_process_table(monkeypatch, {})
    entry = install_config(monkeypatch, 'off')
    svc = make_service(json.loads(state_file.read_text()))

    svc.handle_process(dict(entry, launch_mode='always'))

    assert read_states(state_file)[str(PID)]['status'] == 'KILLED'


def test_an_attempted_relaunch_keeps_the_dead_generation_row(
        state_file, monkeypatch):
    """The constraint that decides WHERE this fix goes.

    When the relaunch is attempted, the dead generation's row must survive the
    attempt: a failed launch has no live pid of its own to key a row by, so
    _surface_launch_failed writes LAUNCH_FAILED onto this one (D5). Retiring it
    in the dead-pid branch at large -- the obvious place -- leaves that write
    nothing to land on, and an entry that cannot launch falls back to the hollow
    INACTIVE ring, which is the exact invisibility LAUNCH_FAILED exists to end.
    Hence the retirement lives in the declined-relaunch bail instead.

    (tests/lifecycle/test_process_lifecycle.py exercises the same contract
    against real processes; this is the cheap local pin.)
    """
    write_states(state_file, {str(PID): row('RUNNING')})
    install_process_table(monkeypatch, {})
    entry = install_config(monkeypatch, 'always')   # still active: relaunch runs
    svc = make_service(json.loads(state_file.read_text()))
    launched = []
    svc.handle_process_launch = lambda process: launched.append(process) or None
    # No live instance to inherit: the relaunch is the only path left.
    svc._find_running_process_by_exe = lambda exe_path, file_path=None: None

    svc.handle_process(dict(entry, launch_mode='always'))

    assert launched, 'the relaunch should have been attempted'
    assert str(PID) in read_states(state_file), (
        'the dead generation row must survive an attempted relaunch - '
        '_surface_launch_failed has nothing else to write onto')


def test_a_live_process_keeps_its_row(state_file, monkeypatch):
    """The whole point is that only an observed-dead pid is retired. A running
    process switched to off keeps its row -- and with it the desktop's kill and
    restart controls, which is what the isLive guard in App.tsx depends on."""
    write_states(state_file, {str(PID): row('RUNNING')})
    install_process_table(monkeypatch, {PID: FakeProc(PID, CREATE_TIME, EXE)})
    entry = install_config(monkeypatch, 'always')
    svc = make_service(json.loads(state_file.read_text()))
    svc.launch_python_script_as_user = lambda *a, **k: None
    svc.handle_unresponsive_process = lambda pid, process: None

    svc.handle_process(dict(entry, launch_mode='always'))

    assert read_states(state_file)[str(PID)]['status'] == 'RUNNING'


def test_nothing_is_terminated(state_file, monkeypatch):
    """Retiring a row is a bookkeeping write. Switching a launch mode off has
    never killed anything and must not start now."""
    write_states(state_file, {str(PID): row('RUNNING')})
    install_process_table(monkeypatch, {})
    entry = install_config(monkeypatch, 'off')
    calls = []
    monkeypatch.setattr(shared_utils, 'graceful_terminate',
                        lambda *a, **k: calls.append(a) or True)
    svc = make_service(json.loads(state_file.read_text()))

    svc.handle_process(dict(entry, launch_mode='always'))

    assert calls == [], 'mode-off must never terminate anything'


def test_shutdown_leaves_the_file_alone(state_file, monkeypatch):
    """During reboot/shutdown the branch suppresses its side effects on the way
    out, and startup re-derives the file anyway."""
    write_states(state_file, {str(PID): row('RUNNING')})
    install_process_table(monkeypatch, {})
    entry = install_config(monkeypatch, 'off')
    svc = make_service(json.loads(state_file.read_text()), shutting_down=True)

    svc.handle_process(dict(entry, launch_mode='always'))

    assert str(PID) in read_states(state_file)


# ==========================================================================
# the sweep, under pid reuse
# ==========================================================================

def test_sweep_drops_a_row_whose_pid_was_recycled(state_file, monkeypatch):
    """The unbounded case. Windows hands the dead process's number to something
    unrelated; bare pid_exists then reads the row as live forever and the entry
    never stops being green.

    NEGATIVE CONTROL: fails against the pre-fix sweep, which keeps the row.
    """
    write_states(state_file, {str(PID): row('RUNNING')})
    install_config(monkeypatch, 'always')
    # Same pid, different process: a later create_time is what recycling looks
    # like, and identity_matches compares it exactly.
    install_process_table(
        monkeypatch,
        {PID: FakeProc(PID, CREATE_TIME + 500.0, 'c:\\windows\\notepad.exe')})
    svc = make_cleanup_service(json.loads(state_file.read_text()))

    svc.cleanup_stale_tracking_data()

    assert str(PID) not in read_states(state_file), (
        'a recycled pid kept a dead row alive')


def test_sweep_keeps_the_row_of_a_process_that_really_is_ours(
        state_file, monkeypatch):
    """The identity check must not sweep a live, matching process."""
    write_states(state_file, {str(PID): row('RUNNING')})
    install_config(monkeypatch, 'always')
    install_process_table(monkeypatch, {PID: FakeProc(PID, CREATE_TIME, EXE)})
    svc = make_cleanup_service(json.loads(state_file.read_text()))

    svc.cleanup_stale_tracking_data()

    assert str(PID) in read_states(state_file)


def test_sweep_keeps_a_live_row_with_no_identity_record(
        state_file, monkeypatch):
    """Pre-3.3.0 state files carry no create_time. There is nothing to verify,
    so those rows keep the old liveness rule instead of being swept on a
    technicality."""
    write_states(state_file, {str(PID): row('RUNNING', create_time=None)})
    install_config(monkeypatch, 'always')
    install_process_table(monkeypatch, {PID: FakeProc(PID, CREATE_TIME, EXE)})
    svc = make_cleanup_service(json.loads(state_file.read_text()))

    svc.cleanup_stale_tracking_data()

    assert str(PID) in read_states(state_file)


# ==========================================================================
# the off-mode tick: the path the REPORTED repro actually takes
# ==========================================================================

def make_offmode_service(results):
    """A service double carrying the real off-mode tick handler.

    The main loop routes an entry by the launch mode it reads at the TOP of the
    tick (owlette_service.py, `if mode == 'always' ... else
    self._relaunch_if_restarting(process)`). So once the mode is off, the entry
    never reaches handle_process again — and the declined-relaunch bail inside it
    is unreachable for that entry from then on.
    """
    from owlette_service import OwletteService
    svc = SimpleNamespace(
        results=results,
        last_started={},
        _skip_launch_delay=set(),
        firebase_client=None,
    )
    svc._relaunch_if_restarting = (
        OwletteService._relaunch_if_restarting.__get__(svc, OwletteService))
    return svc


def test_offmode_tick_retires_a_stale_running_row(state_file, monkeypatch):
    """THE REPORTED REPRO, in the ordering the user described: the process is
    killed and the mode is switched off BEFORE the loop next looks. From the
    next tick on the entry is dispatched to the off-mode handler, so whatever
    handle_process would have done never happens — and nothing retires the row
    until the five-minute sweep.
    """
    write_states(state_file, {str(PID): row('RUNNING')})
    install_process_table(monkeypatch, {})          # the pid is dead
    install_config(monkeypatch, 'off')
    svc = make_offmode_service(json.loads(state_file.read_text()))

    svc._relaunch_if_restarting(dict(ENTRY, launch_mode='off'))

    assert str(PID) not in read_states(state_file), (
        'the off-mode tick left a RUNNING row on a dead pid')
    assert str(PID) not in svc.results


def test_offmode_tick_leaves_a_live_process_alone(state_file, monkeypatch):
    """An off-mode process that is genuinely running keeps its row, and with it
    the desktop's kill and restart controls."""
    write_states(state_file, {str(PID): row('RUNNING')})
    install_process_table(monkeypatch, {PID: FakeProc(PID, CREATE_TIME, EXE)})
    install_config(monkeypatch, 'off')
    svc = make_offmode_service(json.loads(state_file.read_text()))

    svc._relaunch_if_restarting(dict(ENTRY, launch_mode='off'))

    assert read_states(state_file)[str(PID)]['status'] == 'RUNNING'


def test_offmode_tick_keeps_the_restarting_marker(state_file, monkeypatch):
    """The marker this handler exists to read must survive: a desktop restart of
    an off-mode process marks the row RESTARTING, and the pid is dead by design
    while the relaunch is pending."""
    write_states(state_file, {str(PID): row('RESTARTING')})
    install_process_table(monkeypatch, {})
    install_config(monkeypatch, 'off')
    svc = make_offmode_service(json.loads(state_file.read_text()))
    launched = []
    svc.handle_process_launch = lambda process: launched.append(process) or 999

    svc._relaunch_if_restarting(dict(ENTRY, launch_mode='off'))

    # It is consumed by the relaunch, not retired out from under it.
    assert launched, 'a marked restart must still relaunch'


# ==========================================================================
# the transition edge: settle the status the moment the mode flips
# ==========================================================================

def make_transition_service(results):
    """A service double carrying the real launch-mode transition handler."""
    from owlette_service import OwletteService
    svc = SimpleNamespace(
        results=results,
        last_started={},
        manual_overrides={ENTRY_ID: True},
        relaunch_attempts={},
        _skip_launch_delay=set(),
        _cached_site_timezone=None,
        firebase_client=None,
    )
    svc._apply_launch_mode_transition = (
        OwletteService._apply_launch_mode_transition.__get__(svc, OwletteService))
    return svc


def test_switching_to_off_settles_a_dead_process_immediately(
        state_file, monkeypatch):
    """What the user asked for: flipping the mode to off checks whether the pid
    is still alive and settles the status there and then, rather than leaving it
    to a tick that will never look at this entry again.
    """
    write_states(state_file, {str(PID): row('RUNNING')})
    install_process_table(monkeypatch, {})          # closed by hand a moment ago
    svc = make_transition_service(json.loads(state_file.read_text()))

    svc._apply_launch_mode_transition(ENTRY_ID, 'always', 'off', dict(ENTRY))

    assert str(PID) not in read_states(state_file), (
        'the status was left claiming RUNNING at the moment monitoring stopped')
    assert str(PID) not in svc.results


def test_switching_to_off_leaves_a_running_process_alone(
        state_file, monkeypatch):
    """The log line says it outright — "process stays running". Switching the
    mode off has never stopped or hidden a live process, and must not start."""
    write_states(state_file, {str(PID): row('RUNNING')})
    install_process_table(monkeypatch, {PID: FakeProc(PID, CREATE_TIME, EXE)})
    calls = []
    monkeypatch.setattr(shared_utils, 'graceful_terminate',
                        lambda *a, **k: calls.append(a) or True)
    svc = make_transition_service(json.loads(state_file.read_text()))

    svc._apply_launch_mode_transition(ENTRY_ID, 'always', 'off', dict(ENTRY))

    assert read_states(state_file)[str(PID)]['status'] == 'RUNNING'
    assert calls == [], 'mode-off must never terminate anything'


def test_switching_to_off_settles_a_recycled_pid(state_file, monkeypatch):
    """Identity, not bare liveness: the pid is alive, but it belongs to a
    stranger now. The row still describes a process that is gone."""
    write_states(state_file, {str(PID): row('RUNNING')})
    install_process_table(
        monkeypatch,
        {PID: FakeProc(PID, CREATE_TIME + 500.0, 'c:\windows\notepad.exe')})
    svc = make_transition_service(json.loads(state_file.read_text()))

    svc._apply_launch_mode_transition(ENTRY_ID, 'always', 'off', dict(ENTRY))

    assert str(PID) not in read_states(state_file)


def test_switching_to_off_works_when_the_tick_snapshot_is_empty(
        state_file, monkeypatch):
    """The handler also runs off the main loop — a remote config apply, a
    set_launch_mode command — where `self.results` is whatever the last tick
    read and may not hold the row at all. Candidates come from the file."""
    write_states(state_file, {str(PID): row('RUNNING')})
    install_process_table(monkeypatch, {})
    svc = make_transition_service({})               # nothing in the snapshot

    svc._apply_launch_mode_transition(ENTRY_ID, 'always', 'off', dict(ENTRY))

    assert str(PID) not in read_states(state_file)


def test_switching_to_off_leaves_another_entrys_row_alone(
        state_file, monkeypatch):
    """Scoped to the entry whose mode changed. A different process that happens
    to be dead is not this transition's business."""
    write_states(state_file, {
        str(PID): row('RUNNING'),
        '9999': {'id': 'other-proc', 'status': 'RUNNING', 'timestamp': 100},
    })
    install_process_table(monkeypatch, {})
    svc = make_transition_service(json.loads(state_file.read_text()))

    svc._apply_launch_mode_transition(ENTRY_ID, 'always', 'off', dict(ENTRY))

    states = read_states(state_file)
    assert str(PID) not in states
    assert '9999' in states, "another entry's row was swept by this transition"
