"""
tests for the shared_utils identity primitives behind the managed-or-inherited
rule -- read_process_identity / identity_matches, and the extra-fields merge in
update_process_status_in_json that will carry identity records onto pid rows.

Wave 1 of process-identity 3.3.0: these primitives land dark (no caller passes
extra yet), so update_process_status_in_json with extra=None must behave
byte-identically to the pre-wave function -- pinned here with exact-row
assertions.
"""

import json
import logging
import os
import subprocess
import sys

import psutil
import pytest

import shared_utils


# --- read_process_identity ---------------------------------------------------

def test_identity_of_a_real_live_process_round_trips():
    """Read this very python process and match it back to itself."""
    ident = shared_utils.read_process_identity(os.getpid())
    assert ident is not None
    assert ident['pid'] == os.getpid()
    assert ident['create_time'] == psutil.Process(os.getpid()).create_time()
    # exe is stored pre-normalised (backslashes, lowercase) so later
    # comparisons need no re-normalisation.
    assert ident['exe'] == ident['exe'].replace('/', '\\').lower()
    assert shared_utils.identity_matches(ident, os.getpid()) is True


def test_identity_survives_a_json_round_trip():
    """app_states.json is the record's home; repr-based float serialisation
    must preserve create_time bit-for-bit or exact equality would be wrong."""
    ident = shared_utils.read_process_identity(os.getpid())
    thawed = json.loads(json.dumps(ident))
    assert thawed['create_time'] == ident['create_time']
    assert shared_utils.identity_matches(thawed, os.getpid()) is True


def test_dead_pid_reads_none_and_never_matches():
    proc = subprocess.Popen([sys.executable, '-c', 'import time; time.sleep(60)'])
    try:
        ident = shared_utils.read_process_identity(proc.pid)
        assert ident is not None, 'child died before identity read -- setup broken'
    finally:
        proc.kill()
        proc.wait(timeout=30)
    # The Popen handle is still open here, which on Windows keeps the pid from
    # being recycled -- the None below is deterministic, not a timing accident
    # (psutil raises NoSuchProcess for an exited pid even with a held handle).
    assert shared_utils.read_process_identity(proc.pid) is None
    assert shared_utils.identity_matches(ident, proc.pid) is False


def test_access_denied_reads_none(monkeypatch):
    def denied(pid):
        raise psutil.AccessDenied(pid)
    monkeypatch.setattr(shared_utils.psutil, 'Process', denied)
    assert shared_utils.read_process_identity(1234) is None


def test_garbage_pid_reads_none():
    assert shared_utils.read_process_identity(None) is None
    assert shared_utils.read_process_identity('not-a-pid') is None


# --- identity_matches --------------------------------------------------------

def test_pid_reuse_simulation_same_pid_different_create_time_refused():
    """The core PID-reuse defence: right pid, wrong birth time -> stranger."""
    ident = shared_utils.read_process_identity(os.getpid())
    ident['create_time'] += 1.0
    assert shared_utils.identity_matches(ident, os.getpid()) is False


def test_pid_mismatch_refused_before_touching_the_live_process():
    ident = shared_utils.read_process_identity(os.getpid())
    assert shared_utils.identity_matches(ident, os.getpid() + 1) is False


def test_exe_mismatch_refuses_and_warns(caplog):
    """Equal (pid, create_time) but a different exe means the record itself is
    corrupt -- refuse, and say so at WARNING so it surfaces in the logs."""
    ident = shared_utils.read_process_identity(os.getpid())
    ident['exe'] = r'c:\somewhere\else\stranger.exe'
    with caplog.at_level(logging.WARNING):
        assert shared_utils.identity_matches(ident, os.getpid()) is False
    warned = [r for r in caplog.records
              if r.levelname == 'WARNING' and 'identity_matches' in r.getMessage()]
    assert warned, 'exe mismatch must log a warning'


def test_unnormalised_recorded_exe_still_matches():
    """Hand-written or legacy records may carry forward slashes / upper case;
    identity_matches normalises before comparing rather than refusing."""
    ident = shared_utils.read_process_identity(os.getpid())
    ident['exe'] = ident['exe'].replace('\\', '/').upper()
    assert shared_utils.identity_matches(ident, os.getpid()) is True


def test_missing_or_malformed_record_is_false_never_raises():
    assert shared_utils.identity_matches(None, os.getpid()) is False
    assert shared_utils.identity_matches({}, os.getpid()) is False
    assert shared_utils.identity_matches('garbage', os.getpid()) is False
    assert shared_utils.identity_matches({'pid': os.getpid()}, os.getpid()) is False
    assert shared_utils.identity_matches({'pid': 'NaN', 'create_time': 1.0}, os.getpid()) is False
    ident = shared_utils.read_process_identity(os.getpid())
    assert shared_utils.identity_matches(ident, 'not-a-pid') is False


# --- update_process_status_in_json extra-fields merge ------------------------

SCOUT_ROW = {
    'status': 'RUNNING',
    'id': 'proc-1',
    'responsive': False,
    'responsive_prev': True,
    'hung_since': 1111,
}


@pytest.fixture
def state_file(tmp_path, monkeypatch):
    """Redirect app_states.json into the sandbox -- never ProgramData."""
    path = tmp_path / 'app_states.json'
    monkeypatch.setattr(shared_utils, 'RESULT_FILE_PATH', str(path))
    return path


def _row(path, pid):
    with open(path, 'r') as f:
        return json.load(f)[str(pid)]


def test_none_extra_leaves_the_write_path_unchanged(state_file):
    """extra=None must be byte-identical to the pre-wave behaviour: only
    status and id move, scout's per-row fields survive, nothing is added."""
    state_file.write_text(json.dumps({'4242': dict(SCOUT_ROW)}))
    shared_utils.update_process_status_in_json(4242, 'KILLED', None, process_id='proc-1')
    assert _row(state_file, 4242) == {
        'status': 'KILLED',
        'id': 'proc-1',
        'responsive': False,
        'responsive_prev': True,
        'hung_since': 1111,
    }


def test_extra_merges_into_row_preserving_existing_keys(state_file):
    state_file.write_text(json.dumps({'4242': dict(SCOUT_ROW)}))
    extra = {'create_time': 1788624825.8274736, 'exe': r'c:\apps\show.exe', 'managed': True}
    shared_utils.update_process_status_in_json(4242, 'RUNNING', None,
                                               process_id='proc-1', extra=extra)
    assert _row(state_file, 4242) == {
        'status': 'RUNNING',
        'id': 'proc-1',
        'responsive': False,
        'responsive_prev': True,
        'hung_since': 1111,
        'create_time': 1788624825.8274736,
        'exe': r'c:\apps\show.exe',
        'managed': True,
    }


def test_extra_on_a_fresh_pid_creates_the_row(state_file):
    shared_utils.update_process_status_in_json(7, 'LAUNCHING', None,
                                               process_id='proc-2',
                                               extra={'managed': True})
    assert _row(state_file, 7) == {'status': 'LAUNCHING', 'id': 'proc-2', 'managed': True}


def test_non_dict_extra_is_ignored_not_fatal(state_file):
    """A caller bug must not corrupt app_states.json or crash the write."""
    shared_utils.update_process_status_in_json(7, 'RUNNING', None,
                                               process_id='proc-2',
                                               extra=['not', 'a', 'dict'])
    assert _row(state_file, 7) == {'status': 'RUNNING', 'id': 'proc-2'}


def test_none_pid_guard_still_short_circuits(state_file):
    """The None-pid guard predates extra and must keep winning: nothing is
    written, not even when extra is supplied."""
    shared_utils.update_process_status_in_json(None, 'RUNNING', None,
                                               process_id='proc-1',
                                               extra={'managed': True})
    assert not state_file.exists()
