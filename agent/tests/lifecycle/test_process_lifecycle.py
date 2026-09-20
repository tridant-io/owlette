"""Real-process lifecycle suite - the executable contract for process
identity 3.3.0 (plan: dev/active/process-identity/plan.md).

Two sets, one rule (D1): owlette operations touch ONLY processes owlette
manages - ones it launched, or ones it deliberately inherited.

CHARACTERISATION SET - behaviour that is correct today and must stay green
through every wave. Each test pins a load-bearing production path end to
end against REAL processes: real spawns, real psutil, real state files
(redirected), real OwletteService method bodies (descriptor-bound).

NEW-CONTRACT SET - the managed-or-inherited rule itself, written before the
implementation existed. Each landed as xfail(strict=True) tagged with the
wave that had to flip it; an early pass was itself a failure (a guard that
never failed proves nothing - repo rule), and every red was verified to fail
for its contract reason before implementation began. All six flipped green
across Waves 2-5 (markers removed at each flip, comments record which wave
and why); the bodies remain frozen as the permanent contract.

All processes are decoy-image copies (owlette-e2e-decoy-<runid>.exe); no
real-world image name ever appears in a destructive argument. See
conftest.py for the harness contract (decoys, launch seam, isolation probe,
leak policy, forward identity-row schema).
"""

import datetime
import os
import time

import psutil
import pytest

from .conftest import (
    craft_identity_fields,
    is_alive,
    make_entry,
    read_app_states,
    service_spawns,
    tick,
    wait_gone,
    write_app_states,
    write_config,
)

pytestmark = pytest.mark.windows(reason='windows-only process semantics')


def reap(pid):
    """End-of-test cleanup for a process the test made and still owns."""
    try:
        psutil.Process(pid).kill()
    except psutil.Error:
        pass


def launch_managed(svc, entry):
    """Drive the first-start monitor tick that launches the entry for real.

    Returns (pid, create_time) of the live managed child.
    """
    tick(svc, entry)
    info = svc.last_started.get(entry['id'], {})
    pid = info.get('pid')
    assert pid, 'setup: managed launch did not bind a PID'
    create_time = psutil.Process(pid).create_time()
    return pid, create_time


# ==========================================================================
# CHARACTERISATION SET (green today, green forever)
# ==========================================================================

def test_managed_start_binds_real_pid_and_writes_state_row(
        service_factory, decoy_env):
    """A managed launch returns a real PID and writes the app_states row.

    Pins the full pipeline: handle_process -> handle_process_launch ->
    _launch_locked -> launch_process_as_user, with only the
    CreateProcessAsUser syscall shimmed. The row write (timestamp, id,
    LAUNCHING) happens inside the REAL launch_process_as_user body; the
    RUNNING promotion happens on the next REAL monitor tick.
    """
    entry = make_entry('proc-start', 'Start Char', decoy_env.exe)
    write_config([entry])
    svc = service_factory()

    pid, create_time = launch_managed(svc, entry)

    proc = psutil.Process(pid)
    assert os.path.normcase(proc.exe()) == os.path.normcase(decoy_env.exe), \
        'launched PID does not run the configured executable'
    assert is_alive(pid, create_time)

    row = read_app_states().get(str(pid))
    assert row is not None, 'no app_states row for the launched PID'
    assert row['id'] == 'proc-start'
    assert row['status'] == 'LAUNCHING'
    assert isinstance(row['timestamp'], int)

    tick(svc, entry)  # second visit: still running -> RUNNING
    assert read_app_states()[str(pid)]['status'] == 'RUNNING'

    reap(pid)
    assert wait_gone(pid, create_time)


def test_desktop_marker_kill_no_crash_event_no_relaunch_when_off(
        service_factory, decoy_env):
    """Desktop kill marker: KILLED suppresses the crash alert; off suppresses
    the relaunch.

    Mirrors desktop/src/lib/processControl.ts exactly: terminate FIRST, then
    write KILLED (writing early would lie). The mode flip lands in
    config.json after the loop snapshot took the stale entry - the re-read
    inside handle_process is the code under test.
    """
    import shared_utils

    stale_entry = make_entry('proc-marker', 'Marker Char', decoy_env.exe,
                             launch_mode='always')
    write_config([stale_entry])
    svc = service_factory()

    pid, create_time = launch_managed(svc, stale_entry)
    tick(svc, stale_entry)  # promote to RUNNING, as a live loop would have

    # Operator flips the entry off, then kills from the desktop app.
    write_config([make_entry('proc-marker', 'Marker Char', decoy_env.exe,
                             launch_mode='off')])
    reap(pid)
    assert wait_gone(pid, create_time)
    shared_utils.update_process_status_in_json(pid, 'KILLED', None,
                                               process_id='proc-marker')

    svc.first_start = False
    spawned_before = len(service_spawns())
    tick(svc, stale_entry)

    svc._write_cortex_event.assert_not_called()
    assert 'proc-marker' not in svc.last_started, \
        'a marker-killed off-mode entry must drop its tracking'
    assert len(service_spawns()) == spawned_before, \
        'a marker-killed off-mode entry must not be relaunched'
    assert read_app_states()[str(pid)]['status'] == 'KILLED'


def test_unmarked_exit_is_a_crash_and_relaunches(service_factory, decoy_env):
    """Negative control for the marker: a plain death IS a crash.

    Without the KILLED/RESTARTING marker the service emits the crash event
    and relaunches an always-on entry. If this ever stops passing, crash
    supervision itself broke - not the marker.
    """
    entry = make_entry('proc-crash', 'Crash Char', decoy_env.exe)
    write_config([entry])
    svc = service_factory()

    old_pid, old_ct = launch_managed(svc, entry)
    tick(svc, entry)  # RUNNING row, no marker

    reap(old_pid)  # simulated crash: dies with no marker written
    assert wait_gone(old_pid, old_ct)

    svc.first_start = False
    tick(svc, entry)

    assert svc._write_cortex_event.call_count == 1
    assert svc._write_cortex_event.call_args[0][2] == 'process_crash'

    new_pid = svc.last_started.get('proc-crash', {}).get('pid')
    assert new_pid and new_pid != old_pid, 'crash did not relaunch'
    new_ct = psutil.Process(new_pid).create_time()
    assert is_alive(new_pid, new_ct)

    reap(new_pid)
    assert wait_gone(new_pid, new_ct)


def test_restart_path_kill_and_relaunch(service_factory, decoy_env):
    """kill_and_relaunch_process: old PID marked KILLED and terminated, a
    real replacement launched and tracked before the launch lock releases."""
    entry = make_entry('proc-restart', 'Restart Char', decoy_env.exe)
    write_config([entry])
    svc = service_factory()

    old_pid, old_ct = launch_managed(svc, entry)
    svc.first_start = False

    new_pid = svc.kill_and_relaunch_process(old_pid, entry)

    assert new_pid and new_pid != old_pid
    assert wait_gone(old_pid, old_ct), 'old instance survived the restart'
    new_ct = psutil.Process(new_pid).create_time()
    assert is_alive(new_pid, new_ct)
    assert svc.last_started['proc-restart']['pid'] == new_pid

    states = read_app_states()
    assert states[str(old_pid)]['status'] == 'KILLED'
    assert states[str(new_pid)]['status'] == 'LAUNCHING'

    reap(new_pid)
    assert wait_gone(new_pid, new_ct)


def test_stall_path_confirmed_hang_kills_and_relaunches(
        service_factory, decoy_env):
    """handle_unresponsive_process: a hang past HANG_CONFIRM_SECONDS kills
    the real process and relaunches it."""
    entry = make_entry('proc-stall', 'Stall Char', decoy_env.exe)
    write_config([entry])
    svc = service_factory()

    pid, create_time = launch_managed(svc, entry)
    svc.first_start = False
    svc.results = {str(pid): {'responsive': False,
                              'hung_since': int(time.time()) - 30}}

    new_pid = svc.handle_unresponsive_process(pid, entry)

    assert new_pid and new_pid != pid, 'confirmed hang did not restart'
    assert wait_gone(pid, create_time), 'hung instance survived'
    new_ct = psutil.Process(new_pid).create_time()
    assert is_alive(new_pid, new_ct)

    reap(new_pid)
    assert wait_gone(new_pid, new_ct)


def test_pid_liveness_and_graceful_terminate_on_real_decoy(spawn_decoy):
    """Util.is_pid_running / graceful_terminate against a real process:
    True while alive, True on the kill, False once already gone."""
    import shared_utils
    from owlette_service import Util

    popen, pid, create_time = spawn_decoy()
    assert Util.is_pid_running(pid)

    assert shared_utils.graceful_terminate(pid, timeout=2) is True
    assert wait_gone(pid, create_time)
    assert not is_alive(pid, create_time)

    assert shared_utils.graceful_terminate(pid, timeout=2) is False


def test_schedule_window_stop_terminates_out_of_window_process(
        service_factory, spawn_decoy, decoy_env, monkeypatch):
    """The main loop's schedule-window stop actually stops the process.

    The stop stanza lives inline in OwletteService.main(), so this drives
    ONE real iteration of the real loop: heavy startup/loop dependencies not
    under test are stubbed on the double, SLEEP_INTERVAL is zeroed, and
    _write_service_status (the last call of an iteration) flips is_alive.
    The scenario is a mid-session window close - the service is already
    tracking the pid - so startup recovery is stubbed and last_started is
    seeded directly. The termination itself, the tracked-state cleanup and
    the dispatch (scheduled + out-of-window + no override) all run REAL.
    """
    import shared_utils
    import owlette_service
    from unittest.mock import MagicMock

    # days: [] never matches any weekday -> permanently out of window.
    entry = make_entry(
        'proc-sched', 'Sched Char', decoy_env.exe, launch_mode='scheduled',
        schedules=[{'days': [], 'ranges': [{'start': '00:00', 'stop': '23:59'}]}])
    write_config([entry])

    popen, pid, create_time = spawn_decoy()
    svc = service_factory()
    svc.first_start = False
    svc.last_started['proc-sched'] = {'time': datetime.datetime.now(),
                                      'pid': pid}

    for stub in ('_enable_privileges', '_try_launch_tray',
                 '_check_update_status', '_migrate_legacy_roost_cache',
                 '_sweep_legacy_launch_tasks', '_classify_startup_session',
                 '_detect_reboot_success_on_startup',
                 '_revert_stale_display_sentinel',
                 'start_local_config_watcher', '_try_launch_cortex',
                 '_process_cortex_ipc_commands', '_process_privileged_requests', '_check_console_session',
                 '_diff_and_apply_launch_modes',
                 '_check_scheduled_reboot', '_check_display_topology',
                 '_maybe_dispatch_roost_scrub', '_relaunch_if_restarting',
                 'cleanup_stale_tracking_data', 'recover_running_processes',
                 '_check_and_alert_reboot_pending'):
        setattr(svc, stub, MagicMock())

    # The loop branches on this one, so it answers rather than merely records:
    # a truthy MagicMock would exit the loop for a host restart on the first tick.
    svc._restart_requested = MagicMock(return_value=False)

    def _stop_loop():
        svc.is_alive = False
    svc._write_service_status = MagicMock(side_effect=_stop_loop)

    monkeypatch.setattr(owlette_service, 'SLEEP_INTERVAL', 0)
    monkeypatch.setattr(owlette_service.session_state, 'update_alive',
                        lambda: None)
    monkeypatch.setattr(owlette_service.watchdog_state, 'read_pending_history',
                        lambda: [])
    monkeypatch.setattr(shared_utils, 'log_startup_system_snapshot',
                        lambda: None)
    monkeypatch.setattr(shared_utils, 'log_startup_config_summary',
                        lambda: None)

    svc.main()

    assert svc._write_service_status.called, 'loop never completed an iteration'
    assert wait_gone(pid, create_time), \
        'schedule-window stop did not stop the process'
    assert 'proc-sched' not in svc.last_started


# ==========================================================================
# NEW-CONTRACT SET (all green since Wave 5; comments record which wave flipped each)
# ==========================================================================

# Tagged Wave 4 at authoring time but flipped green in Wave 3: what this test
# exercises is REFUSAL (ambiguous match -> None -> handle_process_launch runs
# fresh), not inherit-with-record. Once find_running_process_by_exe stopped
# adopting full_matches[0] on ambiguity, the fresh launch followed with no
# owlette_service change. Inherit (record-on-adopt) is contract (f), still red.
def test_contract_a_ambiguous_image_launches_fresh_and_spares_decoys(
        service_factory, spawn_decoy, decoy_env):
    """(a) N unmanaged decoys, entry matches their image, no file_path =>
    fresh launch; every decoy survives; the new instance is no decoy."""
    entry = make_entry('proc-a', 'Contract A', decoy_env.exe)
    write_config([entry])

    decoys = [spawn_decoy() for _ in range(3)]
    decoy_pids = {pid for _, pid, _ in decoys}

    svc = service_factory()
    tick(svc, entry)

    for _, pid, create_time in decoys:
        assert is_alive(pid, create_time), \
            'an unmanaged decoy was touched by a plain monitor tick'

    recorded = svc.last_started.get('proc-a', {}).get('pid')
    assert recorded is not None, 'entry ended the tick with no bound PID'
    assert recorded not in decoy_pids, \
        'owlette adopted an unmanaged stranger instead of launching fresh'
    fresh = [(p, c) for p, c in service_spawns() if p == recorded]
    assert fresh and is_alive(*fresh[0]), \
        'the recorded PID is not a live instance owlette launched itself'


def test_contract_b_restart_readopts_own_child_and_refuses_squatter(
        service_factory, spawn_decoy, decoy_env):
    """(b) Across simulated service restarts (fresh double, state files
    kept): re-adopt exactly own child; refuse a pid-squatting decoy and
    launch fresh; converge to ONE managed instance."""
    marker = decoy_env.make_marker_script('contract_b')
    entry = make_entry('proc-b', 'Contract B', decoy_env.exe, file_path=marker)
    write_config([entry])

    svc1 = service_factory()
    own_pid, own_ct = launch_managed(svc1, entry)

    # --- restart 1: state file preserved, fresh service -------------------
    svc2 = service_factory()
    svc2.recover_running_processes()
    assert svc2.last_started.get('proc-b', {}).get('pid') == own_pid, \
        'restart did not re-adopt the child owlette launched'

    # --- child dies while stopped; a decoy squats on its recycled pid -----
    states = read_app_states()
    row = states.pop(str(own_pid))
    craft_identity_fields(row, own_ct, decoy_env.exe)  # what Wave 2 records
    reap(own_pid)
    assert wait_gone(own_pid, own_ct)
    _, squatter_pid, squatter_ct = spawn_decoy()  # same image, not our child
    states[str(squatter_pid)] = row  # recycled pid, OLD create_time
    write_app_states(states)

    svc3 = service_factory()
    svc3.recover_running_processes()
    tick(svc3, entry)

    assert is_alive(squatter_pid, squatter_ct), \
        'the squatting decoy was killed'
    adopted = svc3.last_started.get('proc-b', {}).get('pid')
    assert adopted != squatter_pid, \
        'owlette adopted a pid-squatting stranger after restart'
    assert adopted is not None, 'no fresh instance was launched'
    fresh_ct = psutil.Process(adopted).create_time()
    assert is_alive(adopted, fresh_ct)

    # --- restart 2: convergence - exactly one managed instance ------------
    svc4 = service_factory()
    svc4.recover_running_processes()
    tick(svc4, entry)
    managed_alive = [(p, c) for p, c in service_spawns() if is_alive(p, c)]
    assert len(managed_alive) == 1, \
        'restarts did not converge to one managed instance: %r' % managed_alive
    assert svc4.last_started.get('proc-b', {}).get('pid') == managed_alive[0][0]
    assert is_alive(squatter_pid, squatter_ct)


# Flipped green in Wave 5: the kill command resolves its target through the
# durable identity record when tracking is empty (_resolve_kill_target ->
# _resolve_recorded_pid) - the recorded row IS the tracking after a service
# restart - and terminates only the pid the record proves is owlette's own.
def test_contract_c_kill_terminates_only_recorded_pid_among_decoys(
        service_factory, spawn_decoy, decoy_env):
    """(c) Kill on the entry terminates ONLY the recorded pid while
    same-image decoys run; every decoy survives."""
    entry = make_entry('proc-c', 'Contract C', decoy_env.exe,
                       launch_mode='always')
    write_config([entry])
    svc1 = service_factory()
    own_pid, own_ct = launch_managed(svc1, entry)

    # Identity record as Waves 1-2 will persist it (inert today).
    states = read_app_states()
    craft_identity_fields(states[str(own_pid)], own_ct, decoy_env.exe)
    write_app_states(states)

    # Entry flipped off; service restarts: recovery keeps the row but (off
    # mode) never re-tracks the live child - the documented untracked case.
    write_config([make_entry('proc-c', 'Contract C', decoy_env.exe,
                             launch_mode='off')])
    svc2 = service_factory()
    svc2.recover_running_processes()
    assert 'proc-c' not in svc2.last_started

    decoys = [spawn_decoy() for _ in range(2)]

    svc2.handle_firebase_command(
        'cmd-c', {'type': 'kill_process', 'process_id': 'proc-c'})

    assert wait_gone(own_pid, own_ct), \
        'kill aimed at the entry did not terminate its own recorded instance'
    for _, pid, create_time in decoys:
        assert is_alive(pid, create_time), \
            'kill aimed at one entry terminated an unmanaged decoy'


# Flipped green in Wave 5 (D4): the machine-wide psutil name scan is deleted.
# close_processes names now resolve to config entries by exe basename, then to
# those entries' RECORDED pids only, each identity-verified before an
# exe_path-carrying graceful_terminate - unmanaged same-image processes are
# structurally unreachable.
def test_contract_d_deployment_close_spares_unmanaged_decoys(
        service_factory, spawn_decoy, decoy_env):
    """(d) close_processes=[decoy image]: managed instance dies, unmanaged
    decoys survive. THE mass-kill negative control - renamed image only."""
    # Belt and braces: this argument reaches a kill-by-image-name scan.
    assert decoy_env.image.lower().startswith('owlette-e2e-decoy-'), \
        'refusing: close_processes must only ever name the renamed decoy image'

    entry = make_entry('proc-d', 'Contract D', decoy_env.exe)
    write_config([entry])
    svc = service_factory()
    own_pid, own_ct = launch_managed(svc, entry)

    decoys = [spawn_decoy() for _ in range(3)]

    locked = svc._terminate_processes_for_install(
        close_processes=[decoy_env.image],
        suppress_projects=['proc-d'],
        deployment_id='dep-e2e',
        cmd_id='cmd-d')

    assert locked == ['proc-d']
    assert svc.install_locks.get('proc-d') == 'dep-e2e'
    assert wait_gone(own_pid, own_ct), \
        'the managed instance survived its own deployment close'
    for _, pid, create_time in decoys:
        assert is_alive(pid, create_time), \
            'deployment close killed an unmanaged process by bare image name'


# Flipped green in Wave 5: every destructive path re-verifies the recorded
# (pid, create_time) via _identity_gate before acting. A recycled pid fails
# identity_matches, the kill is refused with an Error: string, the stale row
# is removed, and the squatting process is never touched.
def test_contract_e_pid_reuse_mismatch_refuses_kill(
        service_factory, spawn_decoy, decoy_env):
    """(e) A recorded (pid, create_time) whose pid now belongs to a
    different process is refused, not killed."""
    entry = make_entry('proc-e', 'Contract E', decoy_env.exe)
    write_config([entry])
    svc = service_factory()
    own_pid, own_ct = launch_managed(svc, entry)

    states = read_app_states()
    row = states.pop(str(own_pid))
    craft_identity_fields(row, own_ct, decoy_env.exe)
    reap(own_pid)
    assert wait_gone(own_pid, own_ct)

    _, decoy_pid, decoy_ct = spawn_decoy()
    # Simulate OS pid recycling: the record keeps the OLD create_time but
    # its pid now names the decoy.
    states[str(decoy_pid)] = row
    write_app_states(states)
    svc.last_started['proc-e']['pid'] = decoy_pid
    svc.first_start = False

    svc.handle_firebase_command(
        'cmd-e', {'type': 'kill_process', 'process_id': 'proc-e'})

    assert is_alive(decoy_pid, decoy_ct), (
        'PID reuse: the kill path terminated an unrelated process instead '
        'of refusing on create_time mismatch')


# Flipped green in Wave 4: adoption became INHERIT. Every successful match
# now records identity (create_time/exe on the pid row, origin='inherited')
# at the moment of binding, so the inherited process is traceable across a
# restart exactly like a launched one (D1).
def test_contract_f_inherit_writes_durable_identity_record(
        service_factory, spawn_decoy, decoy_env):
    """(f) A pre-existing process unambiguously identified by file_path in
    its cmdline is adopted AND a durable identity row is written."""
    marker = decoy_env.make_marker_script('contract_f')
    entry = make_entry('proc-f', 'Contract F', decoy_env.exe, file_path=marker)
    write_config([entry])

    _, decoy_pid, decoy_ct = spawn_decoy(script=marker)

    svc = service_factory()
    tick(svc, entry)

    assert svc.last_started.get('proc-f', {}).get('pid') == decoy_pid, \
        'the unambiguous (cmdline-corroborated) instance was not adopted'
    assert is_alive(decoy_pid, decoy_ct), 'adoption killed the process'

    row = read_app_states().get(str(decoy_pid))
    assert row is not None and row.get('id') == 'proc-f'
    assert row.get('status') == 'RUNNING'
    assert 'create_time' in row, \
        'inherit did not write a durable identity record on the pid row'
    assert abs(row['create_time'] - decoy_ct) < 1.0, \
        'recorded create_time does not identify the inherited process'


# ==========================================================================
# WAVE 6 ADDITION (Task 6.1, sanctioned: added, no body above modified)
# ==========================================================================

def test_launch_failure_surfaces_launch_failed_on_dead_generation(
        service_factory, decoy_env):
    """A real launch, a real death, then a relaunch that cannot succeed
    (exe_path now missing) leaves LAUNCH_FAILED on the entry's dead
    generation row - visible to the desktop within one monitor tick, with
    every top-level key still a numeric pid string (parseAppStates prunes
    anything else and persists the pruned document)."""
    entry = make_entry('proc-fail', 'Fail Surfacing', decoy_env.exe)
    write_config([entry])
    svc = service_factory()

    pid, create_time = launch_managed(svc, entry)
    tick(svc, entry)  # promote to RUNNING
    reap(pid)
    assert wait_gone(pid, create_time)

    broken = dict(entry, exe_path=os.path.join(
        os.path.dirname(decoy_env.exe), 'owlette-e2e-missing.exe'))
    write_config([broken])
    svc.first_start = False
    tick(svc, broken)  # crash detected; the relaunch hits the missing exe

    states = read_app_states()
    row = states.get(str(pid))
    assert row is not None, 'the dead generation row was not reused'
    assert row['status'] == 'LAUNCH_FAILED'
    assert row['id'] == 'proc-fail'
    assert all(key.isdigit() for key in states), \
        'non-numeric top-level key would be pruned by the desktop parser'
    assert svc.last_started['proc-fail'].get('failed') is True
