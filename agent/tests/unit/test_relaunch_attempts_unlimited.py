"""Regression tests for reached_max_relaunch_attempts and `relaunch_attempts: 0`.

0 has always been documented — and coded for — as "relaunch forever, never
escalate to a machine restart": the escalation branch carries an explicit
`relaunches_to_attempt != 0` guard, and the desktop app's tooltip says
"0 is unlimited".

It never worked. The value was normalised with `if not relaunches_to_attempt:
relaunches_to_attempt = MAX_RELAUNCH_ATTEMPTS`, and `not 0` is True, so every
explicit 0 became 3 before the guard could see it — making the guard dead code
and rebooting machines that were configured never to reboot.

The real method is bound onto a SimpleNamespace via the descriptor protocol
(matching test_cortex_process_command.py) so the production body runs without
constructing the Windows service.
"""

import datetime
import logging
import sys
import threading
import time
from types import SimpleNamespace
from unittest.mock import MagicMock, patch

import pytest


PROC = {'id': 'proc-1', 'name': 'TouchDesigner'}


def _make_service(attempts_so_far):
    from owlette_service import OwletteService

    svc = SimpleNamespace(
        relaunch_attempts={PROC['name']: attempts_so_far},
        first_start=False,
        firebase_client=MagicMock(),
        launch_desktop_app_as_user=MagicMock(return_value=True),
        log_and_notify=MagicMock(),
        _is_restart_prompt_active=MagicMock(return_value=False),
        _restart_prompt_until=0.0,
        # Somebody is at the machine, and has been all along. These are the
        # budget's own rules, and an empty seat is the one input that
        # suspends them (the section below).
        _seat_absent=lambda: False,
        _seatless_entries=set(),
    )
    svc.firebase_client.is_connected.return_value = True
    svc.reached_max_relaunch_attempts = (
        OwletteService.reached_max_relaunch_attempts.__get__(svc, OwletteService))
    return svc


def _run(svc, configured_value):
    """Invoke the method with read_config returning `configured_value`."""
    with patch('owlette_service.shared_utils') as su:
        su.fetch_process_id_by_name.return_value = PROC['id']
        su.read_config.side_effect = lambda *a, **kw: (
            configured_value if kw.get('keys') == ['relaunch_attempts'] else {})
        return svc.reached_max_relaunch_attempts(PROC)


def _assert_escalated(svc):
    """The state an exhausted budget leaves behind: the relaunch gate held,
    the counter cleared, the operator told once.

    On Windows that state is reached by opening the countdown prompt. Off
    Windows the init system owns the desktop app and the daemon never launches
    it (plan decision 2), so the escalation lands on the same state directly —
    gating it on the prompt left the budget unenforced there.
    """
    assert svc._restart_prompt_until > time.monotonic()
    assert PROC['name'] not in svc.relaunch_attempts
    svc.log_and_notify.assert_called_once()
    if sys.platform == 'win32':
        svc.launch_desktop_app_as_user.assert_called_once()
    else:
        svc.launch_desktop_app_as_user.assert_not_called()


@pytest.mark.parametrize('configured', ['0', 0])
def test_zero_never_escalates_to_a_machine_restart(configured):
    """The whole point of 0: keep relaunching, never reboot the machine."""
    svc = _make_service(attempts_so_far=99)  # far beyond any sane limit
    reached = _run(svc, configured)

    assert reached is False, '0 must never report the limit as reached'
    svc.launch_desktop_app_as_user.assert_not_called(), 'no reboot prompt for unlimited'
    svc.firebase_client.set_reboot_pending.assert_not_called()
    # and it keeps counting, so the operator still sees relaunch activity
    assert svc.relaunch_attempts[PROC['name']] == 100


def test_a_real_limit_still_escalates():
    """Guard against 'fixing' 0 by disabling escalation for everyone."""
    svc = _make_service(attempts_so_far=4)  # 4 > 3
    reached = _run(svc, '3')

    assert reached is True
    _assert_escalated(svc)
    svc.firebase_client.set_reboot_pending.assert_called_once()


@pytest.mark.parametrize('configured', [None, '', 'abc', -1])
def test_absent_or_invalid_falls_back_to_the_default(configured):
    """Missing/garbage means "use the default", which still escalates."""
    from owlette_service import MAX_RELAUNCH_ATTEMPTS

    svc = _make_service(attempts_so_far=MAX_RELAUNCH_ATTEMPTS + 1)
    reached = _run(svc, configured)

    assert reached is True, f'{configured!r} should fall back to the default limit'
    _assert_escalated(svc)


def test_under_the_limit_does_not_escalate():
    svc = _make_service(attempts_so_far=1)
    assert _run(svc, '3') is False
    svc.launch_desktop_app_as_user.assert_not_called()


# ==========================================================================
# the seatless POSIX box: a launch that never happened is not a crash
# ==========================================================================
#
# Off Windows a machine with nobody at a graphical seat - logged out, sitting
# at the display manager's greeter, or imaged before its first login - refuses
# every managed launch (plan decision 4), and every refusal used to be counted
# against the relaunch budget. Four minutes of that escalated a crash that
# never happened, and because nothing off Windows ends the countdown the gate
# it armed is indefinite and service-wide: the kiosk user could log back in
# and NOTHING on the machine would launch again until somebody opened the
# dashboard and dismissed the pending reboot. Windows never reached it, its
# own no-session case self-limiting on launch_desktop_app_as_user's False.


def _configured(keys):
    """The two config reads _launch_locked and the budget make."""
    if keys == ['relaunch_attempts']:
        return '3'
    if keys == ['time_to_init']:
        return 0
    return {}


def _launch_service():
    """A service whose real `_launch_locked` drives the real relaunch budget
    through the real POSIX arm of `launch_process_as_user`.

    Only the mechanisms outside this question are doubles: the adapter (the
    seat and the spawn), Firestore and the notifier.
    """
    from owlette_service import OwletteService

    svc = SimpleNamespace(
        relaunch_attempts={},
        first_start=False,
        last_started={},
        results={},
        current_time=datetime.datetime.now(),
        _skip_launch_delay=set(),
        _seat_probe=None,
        _seat_probe_thread=None,
        _seatless_entries=set(),
        _restart_prompt_until=0.0,
        firebase_client=MagicMock(),
        launch_desktop_app_as_user=MagicMock(return_value=True),
        log_and_notify=MagicMock(),
        _write_cortex_event=MagicMock(),
    )
    svc.firebase_client.is_connected.return_value = True
    svc.firebase_client.set_reboot_pending.return_value = True
    for name in ('_launch_locked', '_kill_and_relaunch_locked',
                 'launch_process_as_user', '_record_launch',
                 'reached_max_relaunch_attempts', '_is_restart_prompt_active',
                 '_seat_absent'):
        setattr(svc, name,
                getattr(OwletteService, name).__get__(svc, OwletteService))
    return svc


def _linux_seat(svc, monkeypatch, *, seat, pid=None):
    """A Linux box with or without somebody signed in at it, for one tick.

    Returns the list the adapter records its seat lookups in: the loop
    resolves the seat itself, and how often it does is the point of the first
    test below.
    """
    import owlette_service

    lookups = []

    def console_user():
        lookups.append(seat)
        return seat

    monkeypatch.setattr(sys, 'platform', 'linux')
    monkeypatch.setattr(
        owlette_service, 'osadapter',
        SimpleNamespace(console_user=console_user,
                        launch_managed_process=lambda spec: pid))
    svc._seat_probe = None  # the top of a loop iteration, on the loop thread
    svc._seat_probe_thread = threading.get_ident()
    return lookups


def _configured_reads(su, entry_id):
    """The config reads _launch_locked and the budget make."""
    su.fetch_process_id_by_name.return_value = entry_id
    su.read_config.side_effect = lambda *a, **kw: _configured(kw.get('keys'))
    su.read_json_from_file.return_value = {}
    su.read_process_identity.return_value = None


def _attempt(svc, monkeypatch, entry, *, seat, pid=None):
    """One launch on a Linux box, with or without somebody signed in at it."""
    _linux_seat(svc, monkeypatch, seat=seat, pid=pid)
    # Past the entry's cooldown, so every call in a test really does launch.
    svc.current_time += datetime.timedelta(hours=1)
    with patch('owlette_service.shared_utils') as su:
        _configured_reads(su, entry['id'])
        return svc._launch_locked(entry, None)


def _kiosk_entry(tmp_path, entry_id='proc-1', name='Kiosk'):
    exe = tmp_path / f'{entry_id}-app'
    exe.write_bytes(b'')
    return {'id': entry_id, 'name': name, 'exe_path': str(exe)}


def test_no_seat_never_spends_the_relaunch_budget(monkeypatch, tmp_path):
    """Nobody is signed in, so no launch can happen and none of them is a
    crash: no reboot is pending, the gate is never armed, and the machine
    starts its kiosk itself the moment somebody signs in."""
    from owlette_service import MAX_RELAUNCH_ATTEMPTS

    entry = _kiosk_entry(tmp_path)
    svc = _launch_service()

    for _ in range(MAX_RELAUNCH_ATTEMPTS + 3):
        assert _attempt(svc, monkeypatch, entry, seat=None) is None

    assert svc.relaunch_attempts == {}
    assert svc._restart_prompt_until == 0.0
    assert svc._is_restart_prompt_active() is False
    svc.firebase_client.set_reboot_pending.assert_not_called()

    assert _attempt(svc, monkeypatch, entry, seat='kiosk', pid=4242) == 4242


def test_a_seat_and_the_same_failures_still_escalate(monkeypatch, tmp_path):
    """THE negative control: identical inputs but for the one that matters -
    somebody is at the machine, so a launch that produces no pid IS a crash.
    The budget is spent, the reboot goes pending, and the gate is armed."""
    from owlette_service import MAX_RELAUNCH_ATTEMPTS

    entry = _kiosk_entry(tmp_path)
    svc = _launch_service()

    for _ in range(MAX_RELAUNCH_ATTEMPTS + 1):
        assert _attempt(svc, monkeypatch, entry, seat='kiosk') is None

    assert entry['name'] not in svc.relaunch_attempts
    assert svc._restart_prompt_until == float('inf')
    assert svc._is_restart_prompt_active() is True
    svc.firebase_client.set_reboot_pending.assert_called_once()
    # decision 2: off Windows the daemon never launches the desktop app.
    svc.launch_desktop_app_as_user.assert_not_called()


# ==========================================================================
# what asking costs: the seat is resolved once a tick, and only when due
# ==========================================================================
#
# console_user() is `loginctl list-sessions` plus a `loginctl show-session`
# per session listed, each with a five-second timeout — and the monitor loop
# asked it for every managed entry that is down, on the thread CLAUDE.md
# forbids blocking work on (SLEEP_INTERVAL = 5). Three down entries on a box
# whose loginctl is slow could hold a five-second tick for longer than the
# tick itself.


def test_one_tick_resolves_the_seat_once_however_many_entries_are_down(
        monkeypatch, tmp_path):
    """Three entries down, one answer: the memo is the service's for this
    iteration and is cleared at the top of the next one."""
    svc = _launch_service()
    entries = [_kiosk_entry(tmp_path, f'proc-{n}', f'Kiosk {n}')
               for n in (1, 2, 3)]
    lookups = _linux_seat(svc, monkeypatch, seat=None)
    svc.current_time += datetime.timedelta(hours=1)

    with patch('owlette_service.shared_utils') as su:
        _configured_reads(su, 'proc-1')
        for entry in entries:
            assert svc._launch_locked(entry, None) is None

    # The negative control: one lookup per entry — three — before the memo,
    # and a second one inside the adapter for every launch it then refused.
    assert lookups == [None]

    # And the next tick asks again: a login between two ticks must be seen.
    lookups = _linux_seat(svc, monkeypatch, seat=None)
    svc.current_time += datetime.timedelta(hours=1)
    with patch('owlette_service.shared_utils') as su:
        _configured_reads(su, 'proc-1')
        assert svc._launch_locked(entries[0], None) is None
    assert lookups == [None]


def test_a_tick_with_nothing_due_resolves_no_seat_at_all(
        monkeypatch, tmp_path):
    """And none at all when no launch is due. Every entry is inside the
    cooldown its last refusal started, so the tick has decided there is
    nothing to launch before anything asks who is at the machine."""
    from owlette_service import OwletteService

    svc = _launch_service()
    svc.install_locks = {}
    svc._find_running_process_by_exe = lambda exe_path, file_path: None
    svc.handle_process = OwletteService.handle_process.__get__(
        svc, OwletteService)
    entries = [_kiosk_entry(tmp_path, f'proc-{n}', f'Kiosk {n}')
               for n in (1, 2, 3)]
    for entry in entries:
        svc.last_started[entry['id']] = {
            'time': datetime.datetime.now(), 'pid': None, 'failed': True}
    lookups = _linux_seat(svc, monkeypatch, seat=None)

    with patch('owlette_service.shared_utils') as su:
        _configured_reads(su, 'proc-1')
        for entry in entries:
            svc.handle_process(entry)

    assert lookups == []


def test_an_armed_gate_resolves_no_seat_at_all(monkeypatch, tmp_path):
    """And none at all once the machine has escalated. Off Windows nothing
    but a dashboard dismiss ends that gate, so a box sitting in the
    reboot-pending state paid a loginctl round-trip on the loop thread every
    five seconds, for the life of the install, to re-decide a question the
    gate had already answered."""
    svc = _launch_service()
    entries = [_kiosk_entry(tmp_path, f'proc-{n}', f'Kiosk {n}')
               for n in (1, 2, 3)]
    svc._restart_prompt_until = float('inf')  # escalated, reboot pending

    for _ in range(6):  # six ticks of the five-second loop
        lookups = _linux_seat(svc, monkeypatch, seat='kiosk')
        svc.current_time += datetime.timedelta(hours=1)
        with patch('owlette_service.shared_utils') as su:
            _configured_reads(su, 'proc-1')
            for entry in entries:
                assert svc._launch_locked(entry, None) is None
        # The negative control: one per tick, forever, before the gate
        # outranked the seat probe.
        assert lookups == []


@pytest.mark.parametrize('seat', ['kiosk', None])
def test_an_armed_gate_holds_the_kill_door_with_or_without_a_seat(
        monkeypatch, tmp_path, seat):
    """A machine that escalated is frozen until somebody dismisses the
    pending reboot, and freezing it must not mean killing the kiosk app it
    was frozen to preserve. An unresolved seat is not exotic - loginctl times
    out, and systemd >= 256 reports a session user-incomplete for a moment -
    and it must not be what lets a hang check or a dashboard restart through
    a gate that is holding.
    """
    import owlette_service

    svc = _launch_service()
    entry = _kiosk_entry(tmp_path)
    monkeypatch.setattr(
        owlette_service, '_identity_gate', lambda pid, entry_id: (True, ''))
    _linux_seat(svc, monkeypatch, seat=seat, pid=4242)
    svc._restart_prompt_until = float('inf')

    with patch('owlette_service.shared_utils') as su:
        _configured_reads(su, entry['id'])
        assert svc._kill_and_relaunch_locked(4242, entry) is None
        su.graceful_terminate.assert_not_called()
        su.update_process_status_in_json.assert_not_called()


def test_a_command_thread_does_not_answer_from_the_loop_s_seat_memo(
        monkeypatch, tmp_path):
    """The memo is the loop thread's, and it is a whole tick old by the end
    of the tick. A kiosk user who signs in inside that window must not have
    the start an operator then asks for from the dashboard refused on a
    reading taken before they did.
    """
    svc = _launch_service()
    entry = _kiosk_entry(tmp_path)
    lookups = _linux_seat(svc, monkeypatch, seat='kiosk', pid=4242)
    svc._seat_probe = True  # the loop resolved "nobody is here" this tick
    svc.current_time += datetime.timedelta(hours=1)

    outcome = {}

    def command_thread():
        with patch('owlette_service.shared_utils') as su:
            _configured_reads(su, entry['id'])
            outcome['pid'] = svc._launch_locked(entry, None)

    worker = threading.Thread(target=command_thread)
    worker.start()
    worker.join()

    # The negative control: the memo consumed, no lookup, and the launch
    # refused with "nobody is signed in at a graphical session".
    assert outcome['pid'] == 4242
    assert lookups and set(lookups) == {'kiosk'}
    # and the loop's own answer is left exactly as it was found
    assert svc._seat_probe is True


def test_the_kill_and_relaunch_door_spends_no_budget_without_a_seat(
        monkeypatch, tmp_path):
    """The budget's other door. A restart asked for from the dashboard kills
    the process and relaunches it on the spot, and on a box with nobody
    signed in that relaunch cannot happen either — four of them armed the
    same indefinite, service-wide gate the monitor loop no longer arms. The
    rule lives with the accounting, so it covers every door at once.
    """
    import owlette_service
    from owlette_service import MAX_RELAUNCH_ATTEMPTS

    svc = _launch_service()
    entry = _kiosk_entry(tmp_path)
    monkeypatch.setattr(
        owlette_service, '_identity_gate', lambda pid, entry_id: (True, ''))

    for _ in range(MAX_RELAUNCH_ATTEMPTS + 3):
        _linux_seat(svc, monkeypatch, seat=None)
        with patch('owlette_service.shared_utils') as su:
            _configured_reads(su, entry['id'])
            assert svc._kill_and_relaunch_locked(4242, entry) is None

    assert svc.relaunch_attempts == {}
    assert svc._restart_prompt_until == 0.0
    svc.firebase_client.set_reboot_pending.assert_not_called()


def test_the_kill_and_relaunch_door_with_a_seat_still_escalates(
        monkeypatch, tmp_path):
    """THE negative control for that door: somebody is at the machine, so a
    relaunch that produces no pid is a crash and the budget is spent."""
    import owlette_service
    from owlette_service import MAX_RELAUNCH_ATTEMPTS

    svc = _launch_service()
    entry = _kiosk_entry(tmp_path)
    monkeypatch.setattr(
        owlette_service, '_identity_gate', lambda pid, entry_id: (True, ''))

    for _ in range(MAX_RELAUNCH_ATTEMPTS + 1):
        _linux_seat(svc, monkeypatch, seat='kiosk')
        with patch('owlette_service.shared_utils') as su:
            _configured_reads(su, entry['id'])
            assert svc._kill_and_relaunch_locked(4242, entry) is None

    assert entry['name'] not in svc.relaunch_attempts
    assert svc._restart_prompt_until == float('inf')
    svc.firebase_client.set_reboot_pending.assert_called_once()


def test_a_machine_at_its_greeter_says_it_once_and_not_once_a_minute(
        monkeypatch, tmp_path, caplog):
    """What a box sitting at the display manager's greeter writes to its log.

    A launch that is never attempted is not a failure: two ERROR lines per
    managed entry per minute — the daemon's and the adapter's — plus an
    app_states.json rewritten around a LAUNCH_FAILED row each time, for as
    long as nobody is signed in. One line when the seat goes, one when it
    comes back, and the ERROR kept for a launch that really did fail with
    somebody at the machine.
    """
    svc = _launch_service()
    entry = _kiosk_entry(tmp_path)

    with caplog.at_level(logging.INFO):
        for _ in range(10):
            assert _attempt(svc, monkeypatch, entry, seat=None) is None

        # The negative control: ten of each before, one now.
        assert [r.message for r in caplog.records
                if r.levelno == logging.WARNING] == [
            "Not launching 'Kiosk': nobody is signed in at a graphical "
            "session - launching when somebody is"]
        assert [r.message for r in caplog.records
                if r.levelno >= logging.ERROR] == []
        # The refusal still cools down, so the retry stays at once a minute.
        assert svc.last_started[entry['id']]['failed'] is True

        caplog.clear()
        assert _attempt(svc, monkeypatch, entry, seat='kiosk', pid=4242) == 4242
        assert [r.message for r in caplog.records
                if r.levelno == logging.INFO
                and 'signed in again' in r.message] == [
            "Somebody is signed in again - launching 'Kiosk'"]

        # A new episode is a new line: the state change is what is logged,
        # not the first refusal of the service's life.
        caplog.clear()
        svc.last_started.pop(entry['id'])
        assert _attempt(svc, monkeypatch, entry, seat=None) is None
        assert len([r for r in caplog.records
                    if r.levelno == logging.WARNING]) == 1


def test_a_seatless_refusal_holds_the_entry_for_a_minute_not_a_tick(
        monkeypatch, tmp_path):
    """What the refusal costs, which is what every seat filter is weighed
    against: it records the same `failed` cooldown a failed launch does, and
    that marker gates the next attempt on the entry's time_to_init -- a
    minute by default -- not on the next five-second tick.

    A machine whose seat comes back one tick after a refusal therefore waits
    out the rest of that minute before its kiosk starts. Pricing the refusal
    at one tick understates it twelvefold, and that price is the whole basis
    on which a fail-closed reading of a logind State is chosen over a
    fail-open one.
    """
    import owlette_service

    svc = _launch_service()
    entry = _kiosk_entry(tmp_path)

    assert _attempt(svc, monkeypatch, entry, seat=None) is None
    refused_at = svc.last_started[entry['id']]['time']

    def _seconds_after_the_refusal(offset):
        _linux_seat(svc, monkeypatch, seat='kiosk', pid=4242)
        svc.current_time = refused_at + datetime.timedelta(seconds=offset)
        with patch('owlette_service.shared_utils') as su:
            _configured_reads(su, entry['id'])
            return svc._launch_locked(entry, None)

    # Somebody signs back in on the very next tick. The seat is there, so
    # nothing refuses this launch but the entry's own cooldown.
    assert _seconds_after_the_refusal(owlette_service.SLEEP_INTERVAL) is None
    assert entry['id'] in svc._seatless_entries

    # The negative control: a second short of the cooldown it is still
    # refused, and it is TIME_TO_INIT that ends the wait, not a tick.
    assert _seconds_after_the_refusal(owlette_service.TIME_TO_INIT - 1) is None
    assert _seconds_after_the_refusal(owlette_service.TIME_TO_INIT) == 4242
    assert entry['id'] not in svc._seatless_entries


def test_a_seatless_episode_is_spent_at_the_launch_door_and_only_there(
        monkeypatch, tmp_path):
    """The one thing that bounds the skip: the entry leaves the set at the
    launch door itself, whatever that launch goes on to return.

    `reached_max_relaunch_attempts` refuses to book an entry that is in the
    set, unconditionally and whatever its budget, so a membership that is
    never drained is an entry that relaunches forever and never escalates —
    a crash loop laundered as a logout. Draining it only on a launch that
    produced a pid leaves exactly that hole, the launch that ends a seatless
    episode being the one most likely to fail.
    """
    from owlette_service import MAX_RELAUNCH_ATTEMPTS

    svc = _launch_service()
    entry = _kiosk_entry(tmp_path)

    assert _attempt(svc, monkeypatch, entry, seat=None) is None
    assert entry['id'] in svc._seatless_entries

    # Somebody signed back in and the launch failed anyway: the episode is
    # over either way, and this failure is a crash like any other.
    assert _attempt(svc, monkeypatch, entry, seat='kiosk') is None
    assert entry['id'] not in svc._seatless_entries

    # The negative control: with the membership still held every one of
    # these returns False at the skip, the budget is never spent and no
    # escalation is ever armed.
    for _ in range(MAX_RELAUNCH_ATTEMPTS + 1):
        assert _attempt(svc, monkeypatch, entry, seat='kiosk') is None

    assert svc._restart_prompt_until == float('inf')
    svc.firebase_client.set_reboot_pending.assert_called_once()


# ==========================================================================
# the crash loop the seat rules must never launder
# ==========================================================================
#
# What a crash loop looks like from the loop when somebody IS at the machine,
# in the shape the kiosk VM produced: every launch hands back a real pid and
# the process is gone again by the next tick. That is the reading the seat
# rules sit closest to — a relaunch that "worked" is exactly what a rule
# excusing a death soon after a launch would stop booking — and the
# escalation has to survive it line for line.


def _dead_by_the_next_tick(svc, monkeypatch, entry, *, seat='kiosk', pid=None):
    """One tick for an entry whose last launch has already exited.

    The pid the previous tick recorded is not running any more, which is what
    brings the loop back to the launch door, and the launch this tick makes
    hands back a real pid of its own.
    """
    import owlette_service

    monkeypatch.setattr(
        owlette_service.Util, 'is_pid_running', lambda _pid: False)
    _linux_seat(svc, monkeypatch, seat=seat, pid=pid)
    svc.current_time += datetime.timedelta(hours=1)
    with patch('owlette_service.shared_utils') as su:
        _configured_reads(su, entry['id'])
        # The launch itself succeeded: the process lived long enough for its
        # identity to be recorded, and died after that.
        su.read_process_identity.return_value = {
            'create_time': 1.0, 'exe': entry['exe_path']}
        return svc._launch_locked(entry, None)


def _booked(svc):
    """What the operator was told, in order."""
    return [call.args[1] for call in svc.log_and_notify.call_args_list]


def test_a_crash_loop_of_real_pids_is_booked_and_escalates_once(
        monkeypatch, tmp_path):
    """Three launches, three real pids, three deaths, one escalation.

    A process that starts and dies is the crash the budget exists for: that
    the launch produced a pid, and how soon the process died after it, are
    not reasons to leave the death off the ledger. The gate ends the loop on
    the tick after the last attempt, and the dashboard is told once.
    """
    entry = _kiosk_entry(tmp_path)
    svc = _launch_service()

    for attempt in (1, 2, 3):
        assert _dead_by_the_next_tick(
            svc, monkeypatch, entry, pid=4000 + attempt) == 4000 + attempt
        # The stored counter is the number the NEXT attempt is booked as.
        assert svc.relaunch_attempts[entry['name']] == attempt + 1

    # The budget is spent, so this tick books nothing and launches nothing.
    assert _dead_by_the_next_tick(svc, monkeypatch, entry, pid=4004) is None
    assert svc.last_started[entry['id']]['pid'] == 4003

    assert _booked(svc) == [
        'Process relaunch attempt: 1 of 3',
        'Process relaunch attempt: 2 of 3',
        'Process relaunch attempt: 3 of 3',
        'Terminated Kiosk 3 times. System reboot imminent',
    ]
    assert entry['name'] not in svc.relaunch_attempts
    assert svc._restart_prompt_until == float('inf')
    assert svc._is_restart_prompt_active() is True
    svc.firebase_client.set_reboot_pending.assert_called_once()


def test_a_seatless_episode_neither_spends_nor_clears_the_budget(
        monkeypatch, tmp_path):
    """The rule at the door that enforces it: a logout is neither a charge
    against the relaunch budget nor an amnesty from it.

    Two real crashes book two attempts. Nobody is signed in for the tick
    after that, and the launch that ends the seatless episode books nothing —
    the `failed` cooldown the refusal recorded is not a crashed previous
    attempt — while leaving what the entry had already spent spent. The next
    real crash is attempt 3, and the limit arrives on the tick it always
    would have.
    """
    entry = _kiosk_entry(tmp_path)
    svc = _launch_service()
    booked = ['Process relaunch attempt: 1 of 3',
              'Process relaunch attempt: 2 of 3']

    for attempt in (1, 2):
        assert _dead_by_the_next_tick(
            svc, monkeypatch, entry, pid=4000 + attempt) == 4000 + attempt
    assert _booked(svc) == booked
    assert svc.relaunch_attempts[entry['name']] == 3

    # The seat goes: no launch is attempted, and a refusal is not an attempt.
    assert _dead_by_the_next_tick(svc, monkeypatch, entry, seat=None) is None
    assert entry['id'] in svc._seatless_entries

    # The seat returns, and the launch that ends the episode is not a
    # relaunch: nothing booked, nothing logged, nothing forgiven.
    assert _dead_by_the_next_tick(svc, monkeypatch, entry, pid=4003) == 4003
    assert entry['id'] not in svc._seatless_entries
    assert _booked(svc) == booked
    assert svc.relaunch_attempts[entry['name']] == 3

    # And the next real crash resumes where the entry was, to the line.
    assert _dead_by_the_next_tick(svc, monkeypatch, entry, pid=4004) == 4004
    assert _booked(svc) == booked + ['Process relaunch attempt: 3 of 3']

    assert _dead_by_the_next_tick(svc, monkeypatch, entry, pid=4005) is None
    assert _booked(svc) == booked + [
        'Process relaunch attempt: 3 of 3',
        'Terminated Kiosk 3 times. System reboot imminent',
    ]
    assert svc._restart_prompt_until == float('inf')
    svc.firebase_client.set_reboot_pending.assert_called_once()
