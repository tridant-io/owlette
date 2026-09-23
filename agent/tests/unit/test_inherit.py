"""
tests for Wave 4 of process-identity 3.3.0: adoption becomes INHERIT.

Every site that binds a PID to an entry without owlette having launched it
must write the identity record at the moment of binding (create_time/exe on
the pid row, managed=True, origin='inherited') -- from then on the process is
indistinguishable from a launched one on every later path (D1). A match whose
identity cannot be read (the process died between the match and the read)
must NOT be bound: a bound pid with no record would recreate the
unverifiable-kill-target problem this release closes, so the site declines
the bind and its normal no-match path continues (a fresh launch, per D3).

Sites covered:
  - handle_process first-start adoption
  - handle_process failed-PID-detection rescan
  - handle_process pid-vanished re-scan before relaunch
  - _adopt_running_instance (operator start path)
  - launch_process_as_user PID-file-timeout fallback scan
plus recover_running_processes treating origin='inherited' rows exactly like
'launched' ones, and the convergence property: simulated service restarts
with the state file preserved never duplicate the managed instance and never
disturb the recorded identity.

House patterns: real OwletteService method bodies descriptor-bound onto a
SimpleNamespace (test_cortex_process_command.py); FakeProc + monkeypatched
psutil where unit-scoped (test_process_lookup.py / test_recover_identity.py).
owlette_service is imported lazily inside helpers so collection order cannot
double-initialise the cryptography PyO3 bindings.
"""

import contextlib
import datetime
import json
from types import SimpleNamespace
from unittest.mock import MagicMock

import psutil
import pytest

import shared_utils


ENTRY = {'id': 'proc-1', 'name': 'Demo App', 'exe_path': 'C:\\apps\\demo.exe',
         'launch_mode': 'always'}

# Through the normaliser, not spelled out: the fold is the Windows comparison,
# and off Windows a path is stored exactly as it is read.
EXE_NORMALISED = shared_utils.normalize_exe_path(ENTRY['exe_path'])

INHERIT_FIELDS = {'create_time': 1111.5, 'exe': EXE_NORMALISED,
                  'managed': True, 'origin': 'inherited'}


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
    monkeypatch.setattr(shared_utils, 'read_config',
                        lambda *a, **k: {'processes': [dict(ENTRY)]})


def write_states(path, states):
    path.write_text(json.dumps(states))


def read_states(path):
    if not path.exists():
        return {}
    return json.loads(path.read_text())


def make_handle_service(scan_result, **attrs):
    """A double running the REAL handle_process / recover_running_processes
    bodies. The discovery scan and the launch are seams: the scan returns a
    fixed pid (the ladder has its own suite) and handle_process_launch is a
    spy so a decline's fall-through to a fresh launch is observable without
    spawning anything.
    """
    from owlette_service import OwletteService

    svc = SimpleNamespace(
        install_locks={},
        last_started={},
        first_start=True,
        firebase_client=None,
        _shutting_down=False,
        _skip_launch_delay=set(),
        _cached_site_timezone=None,
        current_time=datetime.datetime.now(),
        results={},
    )
    svc.handle_process = OwletteService.handle_process.__get__(
        svc, OwletteService)
    svc.recover_running_processes = (
        OwletteService.recover_running_processes.__get__(svc, OwletteService))
    svc._find_running_process_by_exe = MagicMock(return_value=scan_result)
    svc.handle_process_launch = MagicMock(return_value=None)
    svc.handle_unresponsive_process = MagicMock(return_value=None)
    svc.launch_python_script_as_user = MagicMock(return_value=True)
    svc._write_cortex_event = MagicMock()
    svc._capture_crash_screenshot = MagicMock(return_value=None)
    for key, value in attrs.items():
        setattr(svc, key, value)
    return svc


def make_adopt_service(scan_result):
    from owlette_service import OwletteService

    svc = SimpleNamespace(last_started={}, firebase_client=None)
    svc._adopt_running_instance = (
        OwletteService._adopt_running_instance.__get__(svc, OwletteService))
    svc._find_running_process_by_exe = MagicMock(return_value=scan_result)
    return svc


# --- per-site inherit-writes-record matrix ----------------------------------

def test_first_start_adoption_writes_inherit_record(
        state_file, config, monkeypatch):
    """first_start site: a surviving instance is inherited WITH its identity
    recorded on the pid row -- not merely rebound by pid number."""
    install_process_table(monkeypatch, {
        500: FakeProc(500, 1111.5, 'C:\\apps\\demo.exe')})
    svc = make_handle_service(500)

    svc.handle_process(dict(ENTRY))

    assert svc.last_started['proc-1']['pid'] == 500
    row = read_states(state_file)['500']
    assert row == dict(INHERIT_FIELDS, id='proc-1', status='RUNNING')
    svc.handle_process_launch.assert_not_called()


def test_failed_rescan_adoption_writes_inherit_record(
        state_file, config, monkeypatch):
    """failed-PID-detection site: the rescan hit is an inherit."""
    install_process_table(monkeypatch, {
        500: FakeProc(500, 1111.5, 'C:\\apps\\demo.exe')})
    svc = make_handle_service(
        500, first_start=False,
        last_started={'proc-1': {'time': datetime.datetime.now(),
                                 'pid': None, 'failed': True}})

    svc.handle_process(dict(ENTRY))

    assert svc.last_started['proc-1']['pid'] == 500
    row = read_states(state_file)['500']
    assert row == dict(INHERIT_FIELDS, id='proc-1', status='RUNNING')
    svc.handle_process_launch.assert_not_called()


def test_pid_vanished_rescan_adoption_writes_inherit_record(
        state_file, config, monkeypatch):
    """pid-vanished site: the tracked pid is gone but a live instance is
    found by the pre-relaunch scan -- inherited with a record, not guessed."""
    install_process_table(monkeypatch, {
        500: FakeProc(500, 1111.5, 'C:\\apps\\demo.exe')})
    # KILLED marker on the dead pid keeps the crash-alert branch quiet; the
    # site under test runs regardless.
    write_states(state_file, {'999': {'id': 'proc-1', 'status': 'KILLED'}})
    svc = make_handle_service(
        500, first_start=False,
        last_started={'proc-1': {'time': datetime.datetime.now(),
                                 'pid': 999}})

    svc.handle_process(dict(ENTRY))

    assert svc.last_started['proc-1']['pid'] == 500
    row = read_states(state_file)['500']
    assert row == dict(INHERIT_FIELDS, id='proc-1', status='RUNNING')
    svc.handle_process_launch.assert_not_called()


def test_adopt_running_instance_writes_inherit_record(
        state_file, config, monkeypatch):
    """operator start path: _adopt_running_instance records identity on the
    strict match it binds."""
    install_process_table(monkeypatch, {
        500: FakeProc(500, 1111.5, 'C:\\apps\\demo.exe')})
    svc = make_adopt_service(500)

    pid = svc._adopt_running_instance(dict(ENTRY))

    assert pid == 500
    assert svc.last_started['proc-1']['pid'] == 500
    # strict discovery is load-bearing on this path (see its docstring)
    _, kwargs = svc._find_running_process_by_exe.call_args
    assert kwargs.get('strict') is True
    row = read_states(state_file)['500']
    assert row == dict(INHERIT_FIELDS, id='proc-1', status='RUNNING')


# --- died between match and read: the bind is declined -----------------------

def test_first_start_decline_falls_through_to_fresh_launch(
        state_file, config, monkeypatch):
    """The scan matched but the process died before its identity could be
    read: no bind, no row -- the normal launch path continues (D3)."""
    install_process_table(monkeypatch, {})  # pid 500 no longer exists
    svc = make_handle_service(500)

    svc.handle_process(dict(ENTRY))

    svc.handle_process_launch.assert_called_once()
    assert 'proc-1' not in svc.last_started
    assert '500' not in read_states(state_file)


def test_adopt_running_instance_decline_returns_none_and_binds_nothing(
        state_file, config, monkeypatch):
    install_process_table(monkeypatch, {})
    svc = make_adopt_service(500)

    assert svc._adopt_running_instance(dict(ENTRY)) is None
    assert svc.last_started == {}
    assert read_states(state_file) == {}


def test_pid_vanished_decline_falls_through_to_fresh_launch(
        state_file, config, monkeypatch):
    install_process_table(monkeypatch, {})
    write_states(state_file, {'999': {'id': 'proc-1', 'status': 'KILLED'}})
    svc = make_handle_service(
        500, first_start=False,
        last_started={'proc-1': {'time': datetime.datetime.now(),
                                 'pid': 999}})

    svc.handle_process(dict(ENTRY))

    svc.handle_process_launch.assert_called_once()
    assert '500' not in read_states(state_file)


# --- launch fallback scan (PID-file timeout) ---------------------------------

@pytest.fixture
def timeout_launch_service(tmp_path, monkeypatch, state_file):
    """A double running the REAL launch_process_as_user body where the faked
    helper never writes the pid handoff file, forcing the fallback-scan path.
    The scan seam returns pid 4242; no process is ever created.
    """
    import sys
    import win32process
    import owlette_service
    from owlette_service import OwletteService

    # Everything get_data_path() resolves must land in the sandbox.
    monkeypatch.setenv('OWLETTE_DATA_ROOT', str(tmp_path / 'Owlette'))
    (tmp_path / 'Owlette' / 'tmp').mkdir(parents=True)
    monkeypatch.setattr(shared_utils, 'get_python_exe_path',
                        lambda: sys.executable)
    monkeypatch.setattr(win32process, 'CreateProcessAsUser',
                        lambda *a, **k: (None, None, 9999, 0))
    # The pid-file poll is pure waiting for a file that will never appear;
    # a no-op sleep keeps the 5s timeout out of the test's wall clock.
    monkeypatch.setattr(owlette_service.time, 'sleep', lambda seconds: None)

    exe = tmp_path / 'target-app.exe'
    exe.write_bytes(b'')  # must exist; the faked spawn never runs it

    svc = SimpleNamespace(
        console_user_token=object(),
        environment=None,
        firebase_client=None,
        _refresh_user_token=lambda: None,
    )
    svc.launch_process_as_user = (
        OwletteService.launch_process_as_user.__get__(svc, OwletteService))
    svc._record_launch = (
        OwletteService._record_launch.__get__(svc, OwletteService))
    svc._validate_path = OwletteService._validate_path
    svc._find_running_process_by_exe = MagicMock(return_value=4242)
    return SimpleNamespace(svc=svc, exe=str(exe))


@pytest.mark.windows(reason='CreateProcessAsUser is the Windows launch seam')
def test_fallback_scan_inherits_with_record(
        timeout_launch_service, state_file, monkeypatch):
    """An unambiguous fallback-scan hit is an inherit: the pid never came
    through the launch handshake, so its identity is captured at bind time."""
    exe = timeout_launch_service.exe
    install_process_table(monkeypatch, {4242: FakeProc(4242, 987.5, exe)})

    pid = timeout_launch_service.svc.launch_process_as_user(
        {'id': 'proc-x', 'name': 'Target', 'exe_path': exe})

    assert pid == 4242
    row = read_states(state_file)['4242']
    assert row == {
        'id': 'proc-x',
        'status': 'LAUNCHING',
        'create_time': 987.5,
        'exe': shared_utils.normalize_exe_path(exe),
        'managed': True,
        'origin': 'inherited',
    }


@pytest.mark.windows(reason='CreateProcessAsUser is the Windows launch seam')
def test_fallback_scan_declines_bind_when_process_died(
        timeout_launch_service, state_file, monkeypatch):
    """Match-then-death at the fallback site reports launch failure instead
    of returning an unrecordable pid."""
    install_process_table(monkeypatch, {})

    pid = timeout_launch_service.svc.launch_process_as_user(
        {'id': 'proc-x', 'name': 'Target',
         'exe_path': timeout_launch_service.exe})

    assert pid is None
    assert '4242' not in read_states(state_file)


# --- inherited rows recover across restart -----------------------------------

@pytest.mark.parametrize('origin', ['launched', 'inherited'])
def test_recovery_readopts_by_identity_regardless_of_origin(
        origin, state_file, config, monkeypatch):
    """recover_running_processes matches on identity, never on origin: an
    inherited row survives a service restart exactly like a launched one."""
    install_process_table(monkeypatch, {
        500: FakeProc(500, 1111.5, 'C:\\apps\\demo.exe')})
    states = {'500': {'id': 'proc-1', 'status': 'RUNNING',
                      'create_time': 1111.5, 'exe': EXE_NORMALISED,
                      'managed': True, 'origin': origin}}
    write_states(state_file, states)
    svc = make_handle_service(None)

    svc.recover_running_processes()

    assert svc.last_started['proc-1']['pid'] == 500
    assert read_states(state_file) == states


@pytest.mark.parametrize('origin', ['launched', 'inherited'])
def test_recovery_refuses_recycled_pid_regardless_of_origin(
        origin, state_file, config, monkeypatch):
    """A recycled pid wearing an inherited record is refused and swept, the
    same as a launched one -- origin never weakens the identity gate."""
    install_process_table(monkeypatch, {
        500: FakeProc(500, 2222.0, 'C:\\apps\\demo.exe')})
    write_states(state_file, {
        '500': {'id': 'proc-1', 'status': 'RUNNING',
                'create_time': 1111.5, 'exe': EXE_NORMALISED,
                'managed': True, 'origin': origin}})
    svc = make_handle_service(None)

    svc.recover_running_processes()

    assert svc.last_started == {}
    assert read_states(state_file) == {}


# --- convergence -------------------------------------------------------------

def test_convergence_restarts_keep_one_instance_and_identity(
        state_file, config, monkeypatch):
    """Inherit once, then two simulated service restarts (fresh double, state
    file preserved): exactly one managed instance remains, its identity row
    is untouched, and no launch or re-discovery ever runs -- the durable
    record is what makes D3's launch-fresh-on-doubt safe."""
    install_process_table(monkeypatch, {
        500: FakeProc(500, 1111.5, 'C:\\apps\\demo.exe')})

    # session 1: first start inherits the pre-existing instance
    svc1 = make_handle_service(500)
    svc1.handle_process(dict(ENTRY))
    assert svc1.last_started['proc-1']['pid'] == 500
    assert read_states(state_file)['500']['origin'] == 'inherited'

    for _restart in range(2):
        svc = make_handle_service(None)
        svc.recover_running_processes()
        svc.handle_process(dict(ENTRY))

        assert svc.last_started['proc-1']['pid'] == 500
        svc.handle_process_launch.assert_not_called()
        # Re-adoption came from the recorded identity, never from scanning.
        svc._find_running_process_by_exe.assert_not_called()
        states = read_states(state_file)
        assert list(states) == ['500'], \
            'restart churned the state file: %r' % states
        assert states['500'] == dict(
            INHERIT_FIELDS, id='proc-1', status='RUNNING')
