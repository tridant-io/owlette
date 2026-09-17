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

The kiosk VM added the rest: the start-up sentinel check reached the same
module, the hung-window scout was launched for every running managed process
on every tick, and the relaunch budget — which escalates only when the restart
prompt opens, and off Windows the daemon never opens one — never stopped
anything.

Methods are bound onto a SimpleNamespace through the descriptor protocol, the
house pattern from test_cortex_process_command.py, so the production bodies run
without building a service.
"""

import datetime
import json
import logging
import os
import subprocess
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


@pytest.fixture
def a_reaped_pid():
    """A pid the daemon will find gone, the way the tick after a logout does."""
    child = subprocess.Popen(['/bin/sleep', '30'])
    child.terminate()
    child.wait(10)
    return child.pid


@pytest.fixture
def an_always_on_kiosk_entry(monkeypatch, tmp_path):
    """One managed entry the daemon relaunches, and an app_states file of its
    own: the dead-pid branch re-reads both."""
    monkeypatch.setattr(
        shared_utils, 'RESULT_FILE_PATH', str(tmp_path / 'app_states.json'))
    monkeypatch.setattr(shared_utils, 'read_config', lambda *args, **kwargs: {
        'processes': [
            {'id': 'kiosk', 'name': 'Kiosk', 'launch_mode': 'always'}]})
    return {'id': 'kiosk', 'name': 'Kiosk'}


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


def test_a_managed_launch_goes_to_the_adapter_and_is_recorded(monkeypatch, tmp_path):
    """The POSIX half of `launch_process_as_user`: no token ladder, the adapter
    resolves the console user and spawns as them, and the durable identity
    record the Windows arm writes is the same one. Nothing else in the suite
    takes this branch — the lifecycle suite and every other `_record_launch`
    test are Windows-marked."""
    states = tmp_path / 'app_states.json'
    monkeypatch.setattr(shared_utils, 'RESULT_FILE_PATH', str(states))
    child = subprocess.Popen(['/bin/sleep', '30'])
    monkeypatch.setattr(osadapter, 'launch_managed_process', lambda spec: child.pid)

    svc = SimpleNamespace(results={}, current_timestamp=0)
    for name in ('launch_process_as_user', '_record_launch'):
        setattr(svc, name, _bound(name, svc))

    try:
        assert svc.launch_process_as_user(
            {'id': 'kiosk', 'exe_path': '/opt/kiosk/app'}) == child.pid
    finally:
        child.terminate()
        child.wait()

    row = json.loads(states.read_text(encoding='utf-8'))[str(child.pid)]
    assert row['id'] == 'kiosk'
    assert row['status'] == 'LAUNCHING'
    assert row['managed'] is True
    assert row['origin'] == 'launched'
    assert row['exe']


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


def test_the_desktop_app_is_not_the_daemons_to_launch(monkeypatch):
    """Decision 2: off Windows the init system starts the app and the daemon
    never does. The Windows body resolves `<install>/app/owlette-desktop.exe`,
    a name that cannot exist here, and warns about it — on start-up, on every
    tick the tray is down, and from the crash escalation."""
    svc = SimpleNamespace(_desktop_exe_missing_logged=False)
    monkeypatch.setattr(
        shared_utils, 'get_desktop_exe_path',
        lambda: pytest.fail('resolved the Windows desktop exe off Windows'))

    assert _bound('launch_desktop_app_as_user', svc)('--tray') is False


def test_the_display_tick_is_a_no_op_and_says_nothing(caplog):
    """display_manager is never ported, and its import alone raises. Anything
    short of returning first logs a warning on every tick for the life of the
    install — the `displays.enabled` switch is below the import and cannot
    reach it."""
    with caplog.at_level(logging.DEBUG):
        assert _bound('_check_display_topology', SimpleNamespace())() is None

    assert caplog.records == []


def test_the_startup_sentinel_check_is_a_no_op_and_says_nothing(caplog):
    """The same duty at start-up, and the same import. Its `except` reported
    the ImportError as `Display sentinel check failed: LUID size mismatch`,
    once per service start, on a platform that has no display manager to
    revert in the first place."""
    with caplog.at_level(logging.DEBUG):
        assert _bound(
            '_revert_stale_display_sentinel', SimpleNamespace())() is None

    assert caplog.records == []


def test_a_running_managed_process_never_launches_the_scout(
        monkeypatch, tmp_path):
    """owlette_scout is IsHungAppWindow, which has no POSIX analogue, and its
    module body imports win32gui. Unguarded it was launched once per running
    managed process per five-second tick: 41 `Python interpreter not found`
    errors in three and a half minutes on the kiosk, and a process that dies on
    ModuleNotFoundError once the packaged interpreter ships."""
    states = tmp_path / 'app_states.json'
    monkeypatch.setattr(shared_utils, 'RESULT_FILE_PATH', str(states))
    child = subprocess.Popen(['/bin/sleep', '30'])
    launched = []

    svc = SimpleNamespace(
        install_locks={},
        first_start=False,
        firebase_client=None,
        current_time=datetime.datetime.now(),
        last_started={'kiosk': {
            'pid': child.pid,
            'time': datetime.datetime.now() - datetime.timedelta(hours=1),
        }},
        launch_python_script_as_user=lambda script, args=None: launched.append(script),
        handle_unresponsive_process=lambda pid, process: None,
    )
    svc.handle_process = _bound('handle_process', svc)

    try:
        svc.handle_process({'id': 'kiosk', 'name': 'Kiosk'})
    finally:
        child.terminate()
        child.wait()

    # The negative control: the unguarded body reaches the launcher here.
    assert launched == []
    assert json.loads(states.read_text(encoding='utf-8'))[str(child.pid)][
        'status'] == 'RUNNING'


def test_an_exhausted_relaunch_budget_stops_relaunching_without_a_prompt(
        monkeypatch, caplog):
    """The escalation is gated on the restart prompt opening, and off Windows
    the daemon never opens one (decision 2) — so the budget was never enforced
    and a crashing kiosk process was relaunched every tick forever. It reaches
    the state the prompt leaves behind instead: reboot pending on the
    dashboard, the relaunch gate held, the counter cleared, said once.
    """
    pending = []
    notified = []
    monkeypatch.setattr(shared_utils, 'read_config', _relaunch_budget_of(3))
    monkeypatch.setattr(
        shared_utils, 'fetch_process_id_by_name', lambda name, data: 'kiosk')

    svc = SimpleNamespace(
        first_start=False,
        relaunch_attempts={'Kiosk': 4},
        _restart_prompt_until=0.0,
        _seat_absent=lambda: False,  # somebody is at the machine
        _seatless_entries=set(),  # and nothing here was refused for want of one
        firebase_client=SimpleNamespace(
            is_connected=lambda: True,
            set_reboot_pending=_pending_writer(pending),
        ),
        log_and_notify=lambda process, reason: notified.append(reason),
        # The negative control: the previous body called this, and a False
        # answer — the only one it has off Windows — fell through to another
        # relaunch.
        launch_desktop_app_as_user=lambda *args: pytest.fail(
            'asked the daemon to open the restart prompt off Windows'),
    )
    svc._is_restart_prompt_active = _bound('_is_restart_prompt_active', svc)

    with caplog.at_level(logging.INFO):
        reached = _bound('reached_max_relaunch_attempts', svc)(
            {'id': 'kiosk', 'name': 'Kiosk'})

    assert reached is True
    assert svc._restart_prompt_until > time.monotonic()
    assert 'Kiosk' not in svc.relaunch_attempts
    assert [p['process_name'] for p in pending] == ['Kiosk']
    assert notified == ['Terminated Kiosk 3 times. System reboot imminent']
    assert 'Failed to open restart prompt.' not in caplog.text


def test_an_exhausted_budget_escalates_once_and_not_every_five_minutes(
        monkeypatch):
    """What ends the gate the escalation arms. On Windows the prompt counts
    down and reboots the machine; off Windows nothing does, so a gate that
    expires re-escalates for the life of the install — another reboot_pending
    write and another 'reboot imminent' alert every five minutes, at a
    dashboard that already carries both. It is held until the dismiss.
    """
    pending = []
    notified = []
    monkeypatch.setattr(shared_utils, 'read_config', _relaunch_budget_of(3))
    monkeypatch.setattr(
        shared_utils, 'fetch_process_id_by_name', lambda name, data: 'kiosk')

    svc = SimpleNamespace(
        first_start=False,
        relaunch_attempts={'Kiosk': 4},
        _restart_prompt_until=0.0,
        _seat_absent=lambda: False,  # somebody is at the machine
        _seatless_entries=set(),  # and nothing here was refused for want of one
        firebase_client=SimpleNamespace(
            is_connected=lambda: True,
            set_reboot_pending=_pending_writer(pending),
        ),
        log_and_notify=lambda process, reason: notified.append(reason),
        launch_desktop_app_as_user=lambda *args: pytest.fail(
            'asked the daemon to open the restart prompt off Windows'),
    )
    svc._is_restart_prompt_active = _bound('_is_restart_prompt_active', svc)
    reached = _bound('reached_max_relaunch_attempts', svc)
    process = {'id': 'kiosk', 'name': 'Kiosk'}

    assert reached(process) is True

    # A day later, the process still crashing and nobody at the dashboard.
    later = time.monotonic() + 86400
    monkeypatch.setattr(time, 'monotonic', lambda: later)
    svc.relaunch_attempts['Kiosk'] = 4

    assert reached(process) is True
    assert [p['process_name'] for p in pending] == ['Kiosk']
    assert notified == ['Terminated Kiosk 3 times. System reboot imminent']


def test_an_escalation_nobody_can_see_does_not_freeze_the_relaunches(
        monkeypatch):
    """What arms the indefinite gate: the dashboard row, not the platform. The
    gate is cleared by a dismiss and by nothing else, so arming it whenever the
    agent is off Windows froze every relaunch on the machine — service-wide —
    on a machine whose reboot_pending write never left it. An unwritten row
    takes the timed gate instead, and the escalation runs again once the agent
    is connected and there is something to dismiss.
    """
    from owlette_service import RESTART_PROMPT_ACTIVE_SECONDS

    notified = []
    monkeypatch.setattr(shared_utils, 'read_config', _relaunch_budget_of(3))
    monkeypatch.setattr(
        shared_utils, 'fetch_process_id_by_name', lambda name, data: 'kiosk')

    svc = SimpleNamespace(
        first_start=False,
        relaunch_attempts={'Kiosk': 4},
        _restart_prompt_until=0.0,
        _seat_absent=lambda: False,  # somebody is at the machine
        _seatless_entries=set(),  # and nothing here was refused for want of one
        firebase_client=SimpleNamespace(
            is_connected=lambda: True,
            set_reboot_pending=_pending_writer([], written=False),
        ),
        log_and_notify=lambda process, reason: notified.append(reason),
        launch_desktop_app_as_user=lambda *args: pytest.fail(
            'asked the daemon to open the restart prompt off Windows'),
    )
    svc._is_restart_prompt_active = _bound('_is_restart_prompt_active', svc)
    reached = _bound('reached_max_relaunch_attempts', svc)
    process = {'id': 'kiosk', 'name': 'Kiosk'}

    assert reached(process) is True
    # The negative control: armed on the platform alone this is float('inf').
    assert svc._restart_prompt_until <= (
        time.monotonic() + RESTART_PROMPT_ACTIVE_SECONDS)

    # Once the gate has run out the escalation is free to try again, which is
    # the only way the row is ever written.
    later = time.monotonic() + RESTART_PROMPT_ACTIVE_SECONDS + 1
    monkeypatch.setattr(time, 'monotonic', lambda: later)
    svc.relaunch_attempts['Kiosk'] = 4
    written = []
    svc.firebase_client.set_reboot_pending = _pending_writer(written)

    assert reached(process) is True
    assert [row['process_name'] for row in written] == ['Kiosk']
    assert svc._restart_prompt_until == float('inf')
    assert notified == ['Terminated Kiosk 3 times. System reboot imminent'] * 2


def test_a_budget_still_under_its_limit_keeps_relaunching(monkeypatch):
    """The other half of the gate: nothing about the escalation may stop a
    process that has attempts left from being relaunched."""
    monkeypatch.setattr(shared_utils, 'read_config', _relaunch_budget_of(3))
    monkeypatch.setattr(
        shared_utils, 'fetch_process_id_by_name', lambda name, data: 'kiosk')

    svc = SimpleNamespace(
        first_start=False,
        relaunch_attempts={'Kiosk': 2},
        _restart_prompt_until=0.0,
        _seat_absent=lambda: False,  # somebody is at the machine
        _seatless_entries=set(),  # and nothing here was refused for want of one
        firebase_client=None,
        log_and_notify=lambda process, reason: None,
        launch_desktop_app_as_user=lambda *args: pytest.fail(
            'escalated a budget that still had attempts left'),
    )
    svc._is_restart_prompt_active = _bound('_is_restart_prompt_active', svc)

    assert _bound('reached_max_relaunch_attempts', svc)(
        {'id': 'kiosk', 'name': 'Kiosk'}) is False
    assert svc.relaunch_attempts['Kiosk'] == 3


def test_the_launch_that_ends_a_seatless_period_is_not_a_relaunch(monkeypatch):
    """The refusal that costs no budget still records the `failed` cooldown
    marker — it is what holds the retry to once a minute while nobody is
    signed in — and the launch that follows the seat's return read that
    marker back as a crashed previous attempt: `Process relaunch attempt: 1
    of N`, once per managed entry per logout, six of them in the VM rerun. On
    a three-attempt entry three logout/login cycles would escalate a machine
    that never crashed anything.
    """
    notified = []
    monkeypatch.setattr(shared_utils, 'read_config', _relaunch_budget_of(3))
    monkeypatch.setattr(
        shared_utils, 'fetch_process_id_by_name', lambda name, data: 'kiosk')

    svc = SimpleNamespace(
        first_start=False,
        relaunch_attempts={},
        _restart_prompt_until=0.0,
        _seat_absent=lambda: False,  # somebody signed back in
        _seatless_entries={'kiosk'},
        firebase_client=None,
        log_and_notify=lambda process, reason: notified.append(reason),
        launch_desktop_app_as_user=lambda *args: pytest.fail(
            'escalated an entry that has not crashed once'),
    )
    svc._is_restart_prompt_active = _bound('_is_restart_prompt_active', svc)

    assert _bound('reached_max_relaunch_attempts', svc)(
        {'id': 'kiosk', 'name': 'Kiosk'}) is False

    # The negative control: booked as a relaunch this logs 'Process relaunch
    # attempt: 1 of 3' and leaves the counter at 2.
    assert notified == []
    assert svc.relaunch_attempts == {}


def test_a_budget_spent_before_the_seat_went_away_is_not_cleared(monkeypatch):
    """The other half of that rule: a seatless period is not an amnesty.

    The launch that ends one books nothing and logs nothing, and what the
    entry had already spent is still spent — so a process crash-looping
    across a logout resumes at the attempt it was on and still reaches its
    limit on the tick it always would have.
    """
    pending = []
    notified = []
    monkeypatch.setattr(shared_utils, 'read_config', _relaunch_budget_of(3))
    monkeypatch.setattr(
        shared_utils, 'fetch_process_id_by_name', lambda name, data: 'kiosk')

    svc = SimpleNamespace(
        first_start=False,
        # Two attempts already booked; 3 is the number the next one takes.
        relaunch_attempts={'Kiosk': 3},
        _restart_prompt_until=0.0,
        _seat_absent=lambda: False,
        _seatless_entries={'kiosk'},
        firebase_client=SimpleNamespace(
            is_connected=lambda: True,
            set_reboot_pending=_pending_writer(pending),
        ),
        log_and_notify=lambda process, reason: notified.append(reason),
        launch_desktop_app_as_user=lambda *args: pytest.fail(
            'asked the daemon to open the restart prompt off Windows'),
    )
    svc._is_restart_prompt_active = _bound('_is_restart_prompt_active', svc)
    reached = _bound('reached_max_relaunch_attempts', svc)
    process = {'id': 'kiosk', 'name': 'Kiosk'}

    assert reached(process) is False
    assert notified == []
    assert svc.relaunch_attempts == {'Kiosk': 3}

    # The launch door drains the entry there, so the next death is a crash
    # like any other — and it is the third, not the first.
    svc._seatless_entries.discard('kiosk')
    assert [reached(process) for _ in range(2)] == [False, True]
    assert notified == [
        'Process relaunch attempt: 3 of 3',
        'Terminated Kiosk 3 times. System reboot imminent',
    ]
    assert [row['process_name'] for row in pending] == ['Kiosk']
    assert 'Kiosk' not in svc.relaunch_attempts


def test_a_crash_loop_at_a_healthy_seat_still_books_and_escalates(monkeypatch):
    """The negative control for both of the rules above, and for the seat
    check that answers them: a process that dies a second after every launch
    with somebody signed in is a crash loop, it is booked line by line, and it
    escalates on schedule. Nothing about a logout may launder that.
    """
    pending = []
    notified = []
    monkeypatch.setattr(shared_utils, 'read_config', _relaunch_budget_of(3))
    monkeypatch.setattr(
        shared_utils, 'fetch_process_id_by_name', lambda name, data: 'kiosk')

    svc = SimpleNamespace(
        first_start=False,
        relaunch_attempts={},
        _restart_prompt_until=0.0,
        _seat_absent=lambda: False,
        _seatless_entries=set(),
        firebase_client=SimpleNamespace(
            is_connected=lambda: True,
            set_reboot_pending=_pending_writer(pending),
        ),
        log_and_notify=lambda process, reason: notified.append(reason),
        launch_desktop_app_as_user=lambda *args: pytest.fail(
            'asked the daemon to open the restart prompt off Windows'),
    )
    svc._is_restart_prompt_active = _bound('_is_restart_prompt_active', svc)
    reached = _bound('reached_max_relaunch_attempts', svc)
    process = {'id': 'kiosk', 'name': 'Kiosk'}

    assert [reached(process) for _ in range(4)] == [False, False, False, True]
    assert notified == [
        'Process relaunch attempt: 1 of 3',
        'Process relaunch attempt: 2 of 3',
        'Process relaunch attempt: 3 of 3',
        'Terminated Kiosk 3 times. System reboot imminent',
    ]
    assert [row['process_name'] for row in pending] == ['Kiosk']


_CRASH_SHOT_URL = 'https://example.invalid/crash.png'


def _a_dead_generation(dead_pid):
    """last_started as the tick reads it for a process that has since died."""
    return {
        'pid': dead_pid,
        'time': datetime.datetime.now() - datetime.timedelta(hours=1),
    }


def _daemon_that_finds_a_dead_entry(dead_pid, seat_absent):
    """The tick that finds a managed process gone, with everything the crash
    path would send recorded rather than sent. handle_process_launch stands in
    for the launch door, whose own seat rule decides whether anything starts.
    """
    recorded = SimpleNamespace(
        events=[], alerts=[], cortex=[], screenshots=[], launched=[])
    svc = SimpleNamespace(
        install_locks={},
        first_start=False,
        _shutting_down=False,
        current_time=datetime.datetime.now(),
        last_started={'kiosk': _a_dead_generation(dead_pid)},
        _seat_absent=lambda: seat_absent,
        _seatless_entries=set(),
        firebase_client=SimpleNamespace(
            is_connected=lambda: True,
            log_event=lambda **row: recorded.events.append(row),
            send_process_alert=lambda name, details, kind: recorded.alerts.append(kind),
        ),
        _capture_crash_screenshot=lambda: (
            recorded.screenshots.append('captured') or _CRASH_SHOT_URL),
        _write_cortex_event=lambda name, details, kind: recorded.cortex.append(kind),
        handle_process_launch=lambda process: recorded.launched.append(process['id']),
    )
    svc.handle_process = _bound('handle_process', svc)
    return svc, recorded


def test_an_app_that_ended_with_the_operators_session_is_not_a_crash(
        an_always_on_kiosk_entry, a_reaped_pid, caplog):
    """Owner decision 2026-09-16. Logging out of the kiosk takes every managed
    GUI app with the session, and the tick that noticed filed each one as a
    process_crash: an error event, an alert to whoever is on call, and a crash
    screenshot of a desktop that no longer exists — while the daemon was
    already doing the right thing underneath and waiting for the seat to come
    back. Those deaths are the logout. Said once per entry per episode, INFO.
    """
    svc, recorded = _daemon_that_finds_a_dead_entry(
        a_reaped_pid, seat_absent=True)

    with caplog.at_level(logging.INFO):
        svc.handle_process(an_always_on_kiosk_entry)
        # The door's own refusal never comes back through here: it records
        # a pid-less `failed` generation, which no later tick reads as a
        # death. What does is an entry adopted by exe match while the
        # seatless mark stands - both adoption paths return without
        # clearing it - and then killed by the same logout. Staged here,
        # because the stub door records rather than refuses.
        svc.last_started['kiosk'] = _a_dead_generation(a_reaped_pid)
        svc.handle_process(an_always_on_kiosk_entry)

    # The negative control: ungated, each tick sends all four of these.
    assert recorded.events == []
    assert recorded.alerts == []
    assert recorded.cortex == []
    assert recorded.screenshots == []
    # What does not change: the entry still reaches the launch door, which is
    # where the seatless rule holds it until somebody signs back in. Marking
    # it there is also what stands the door's own seatless WARNING down: this
    # entry's episode opens with the INFO above instead.
    assert recorded.launched == ['kiosk', 'kiosk']
    assert svc._seatless_entries == {'kiosk'}
    assert caplog.text.count('ended with the graphical session') == 1


def test_a_death_at_a_healthy_seat_is_still_a_crash(
        an_always_on_kiosk_entry, a_reaped_pid, caplog):
    """The control the gate is judged by: it reads the seat, not the death.
    With somebody signed in, a managed process gone by the next tick is the
    crash it always was — event, alert, screenshot and cortex event, exactly
    as before — and nothing about it is filed as a logout.
    """
    svc, recorded = _daemon_that_finds_a_dead_entry(
        a_reaped_pid, seat_absent=False)

    with caplog.at_level(logging.INFO):
        svc.handle_process(an_always_on_kiosk_entry)

    assert [event['action'] for event in recorded.events] == ['process_crash']
    assert recorded.events[0]['screenshot_url'] == _CRASH_SHOT_URL
    assert recorded.alerts == ['process_crash']
    assert recorded.cortex == ['process_crash']
    assert recorded.screenshots == ['captured']
    assert recorded.launched == ['kiosk']
    assert svc._seatless_entries == set()
    assert 'ended with the graphical session' not in caplog.text


def test_a_death_one_tick_after_the_seat_returned_is_a_crash(
        an_always_on_kiosk_entry, a_reaped_pid):
    """The edge between the two: an entry still carrying the last episode's
    mark, dying with the seat back. That mark is bookkeeping for the launch
    door, not a licence to swallow an alert — only the seat answers this.
    """
    svc, recorded = _daemon_that_finds_a_dead_entry(
        a_reaped_pid, seat_absent=False)
    svc._seatless_entries.add('kiosk')

    svc.handle_process(an_always_on_kiosk_entry)

    assert [event['action'] for event in recorded.events] == ['process_crash']
    assert recorded.alerts == ['process_crash']


def test_a_deployment_resolves_its_close_names_against_the_managed_entries(
        monkeypatch):
    """A roost deployment closes the managed processes that hold the files it
    is about to overwrite, and it names them by image. That name was matched
    against the entries with separators and case folded on every platform, so
    on a case-sensitive filesystem it resolved against no entry at all: the
    deployment logged that it manages nothing by that name and extracted over
    a running application.
    """
    import owlette_service

    exe = '/opt/kiosk/Kiosk-App'
    terminated = []
    monkeypatch.setattr(shared_utils, 'read_config', lambda *args, **kwargs: {
        'processes': [{'id': 'kiosk', 'name': 'Kiosk', 'exe_path': exe}]})
    monkeypatch.setattr(
        owlette_service, '_identity_gate', lambda pid, entry_id: (True, ''))
    monkeypatch.setattr(
        owlette_service, '_resolve_recorded_pid', lambda entry_id: 4242)
    monkeypatch.setattr(
        shared_utils, 'graceful_terminate',
        lambda pid, exe_path=None: terminated.append((pid, exe_path)))
    monkeypatch.setattr(
        shared_utils, 'update_process_status_in_json',
        lambda pid, status, client, process_id=None: None)
    monkeypatch.setattr(time, 'sleep', lambda seconds: None)

    svc = SimpleNamespace(firebase_client=None, install_locks={}, last_started={})

    locked = _bound('_terminate_processes_for_install', svc)(
        ['Kiosk-App'], [], 'deploy-1', 'cmd-1')

    # The negative control: folded, the name became `kiosk-app` and the entry
    # `\opt\kiosk\kiosk-app`, which share no basename — nothing was closed.
    assert terminated == [(4242, exe)]
    assert locked == []


def test_a_live_managed_process_is_adopted_rather_than_launched_again(
        tmp_path, monkeypatch, private_executable):
    """Task 3.1's own Done-when: restarting the daemon with a managed process
    running leaves that pid alive and the agent re-adopts it. The lookup every
    adoption tier is fed by folded separators on POSIX, so nothing was ever
    found and handle_process launched a second copy on top of the live one.
    """
    monkeypatch.setattr(
        shared_utils, 'RESULT_FILE_PATH', str(tmp_path / 'app_states.json'))
    exe = private_executable('kiosk-app')
    child = subprocess.Popen([str(exe), '30'])
    svc = SimpleNamespace(last_started={}, firebase_client=None)
    svc._find_running_process_by_exe = _bound(
        '_find_running_process_by_exe', svc)
    try:
        adopted = _bound('_adopt_running_instance', svc)(
            {'id': 'kiosk', 'name': 'Kiosk', 'exe_path': str(exe),
             'file_path': ''})
    finally:
        child.terminate()
        child.wait(10)

    assert adopted == child.pid
    assert svc.last_started['kiosk']['pid'] == child.pid
    row = shared_utils.read_json_from_file(
        shared_utils.RESULT_FILE_PATH)[str(child.pid)]
    assert row['status'] == 'RUNNING'
    assert row['origin'] == 'inherited'


def _relaunch_budget_of(attempts):
    """read_config as the escalation reads it: the entry's budget, and the
    whole document for the name-to-id lookup."""
    def _read_config(keys=None, process_list_id=None):
        return attempts if keys == ['relaunch_attempts'] else {}

    return _read_config


def _pending_writer(rows, written=True):
    """firebase_client.set_reboot_pending, which reports whether the row it
    was asked for reached Firestore."""
    def _set_reboot_pending(**row):
        rows.append(row)
        return written

    return _set_reboot_pending


def test_the_hoot_launcher_does_not_resolve_the_seat_on_every_tick(monkeypatch):
    """Resolving the console user off Windows is `loginctl list-sessions` plus
    a `loginctl show-session` per session, each with a five-second budget, and
    the hoot launcher stamped its cooldown only on success — so a kiosk with
    hoot enabled and nobody signed in paid for those subprocesses on the 5s
    loop thread, tick after tick. A failure is paced like the tray launcher's.
    """
    resolved = []
    monkeypatch.setattr(shared_utils, 'is_cortex_enabled', lambda config=None: True)
    monkeypatch.setattr(
        shared_utils, 'get_python_exe_path',
        lambda: '/opt/owlette/python/bin/python3')
    monkeypatch.setattr(
        osadapter, 'console_user', lambda: resolved.append(None))

    svc = SimpleNamespace(
        cortex_pid=None,
        _cortex_last_launch_time=0.0,
        _cortex_launch_cooldown=30,
    )
    for name in ('_is_cortex_alive', 'launch_python_script_as_user',
                 '_spawn_as_console_user'):
        setattr(svc, name, _bound(name, svc))
    tick = _bound('_try_launch_cortex', svc)

    assert tick() is False
    assert tick() is False

    # The negative control: unstamped, the second tick resolves the seat again.
    assert len(resolved) == 1


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
