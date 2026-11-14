"""A managed process that ends cleanly is not a crash.

`/usr/bin/sleep 3600` on the kiosk VM exits 0 every hour, and the tick that
noticed booked each exit as a process_crash: an error event, an alert, a crash
screenshot, a cortex investigation and one attempt off the relaunch budget,
until the tenth armed a reboot pending, 'lab-sleep crashed 9 times', on a
machine where nothing had crashed. The daemon only asked whether the pid was
alive; it now asks the adapter how the process ended.
"""

import datetime
import os
import subprocess
import sys
from types import SimpleNamespace

import pytest

import osadapter
import shared_utils

_AN_HOUR = datetime.timedelta(hours=1)


def _bound(name, svc):
    from owlette_service import OwletteService

    return getattr(OwletteService, name).__get__(svc, OwletteService)


@pytest.fixture
def a_dead_pid():
    child = subprocess.Popen([sys.executable, '-c', ''])
    child.wait(30)
    return child.pid


@pytest.fixture
def an_always_on_entry(monkeypatch, tmp_path):
    monkeypatch.setattr(
        shared_utils, 'RESULT_FILE_PATH', str(tmp_path / 'app_states.json'))
    monkeypatch.setattr(shared_utils, 'read_config', lambda *args, **kwargs: {
        'processes': [{'id': 'kiosk', 'name': 'Kiosk', 'launch_mode': 'always'}]})
    return {'id': 'kiosk', 'name': 'Kiosk'}


def _daemon_whose_process_ended(monkeypatch, dead_pid, *, code, ran_for):
    """The tick that finds a managed process gone after `ran_for`, with the
    adapter reporting `code` for it and everything the tick sends recorded."""
    monkeypatch.setattr(
        osadapter, 'exit_code', lambda pid: code if pid == dead_pid else None)
    recorded = SimpleNamespace(
        events=[], alerts=[], cortex=[], screenshots=[], launched=[])
    now = datetime.datetime.now()
    svc = SimpleNamespace(
        install_locks={},
        first_start=False,
        _shutting_down=False,
        current_time=now,
        last_started={'kiosk': {'pid': dead_pid, 'time': now - ran_for}},
        _seat_absent=lambda: False,
        _seatless_entries=set(),
        firebase_client=SimpleNamespace(
            is_connected=lambda: True,
            log_event=lambda **row: recorded.events.append(row),
            send_process_alert=lambda name, details, kind: recorded.alerts.append(kind),
        ),
        _capture_crash_screenshot=lambda: recorded.screenshots.append('captured'),
        _write_cortex_event=lambda name, details, kind: recorded.cortex.append(kind),
        handle_process_launch=lambda process, after_crash: recorded.launched.append(after_crash),
    )
    svc.handle_process = _bound('handle_process', svc)
    return svc, recorded


def test_a_process_that_finished_its_run_is_relaunched_without_a_crash(
        monkeypatch, an_always_on_entry, a_dead_pid):
    svc, recorded = _daemon_whose_process_ended(
        monkeypatch, a_dead_pid, code=0, ran_for=_AN_HOUR)

    svc.handle_process(an_always_on_entry)

    assert [(e['action'], e['level']) for e in recorded.events] == [('process_exited', 'info')]
    assert (recorded.alerts, recorded.cortex, recorded.screenshots) == ([], [], [])
    # always-on still means always on: relaunched, just not as a crash.
    assert recorded.launched == [False]


def test_closing_it_straight_after_launch_is_not_a_crash_either(
        monkeypatch, an_always_on_entry, a_dead_pid):
    """Somebody closing an app that keeps coming back closes it within
    seconds of each relaunch, and every one of those closes was booked as a
    crash until the budget raised a restart pending."""
    svc, recorded = _daemon_whose_process_ended(
        monkeypatch, a_dead_pid, code=0, ran_for=datetime.timedelta(seconds=5))

    svc.handle_process(an_always_on_entry)

    assert [(e['action'], e['level']) for e in recorded.events] == [('process_exited', 'info')]
    assert (recorded.alerts, recorded.cortex, recorded.screenshots) == ([], [], [])
    # a program that exits 0 straight after every launch (a launcher that
    # hands off and quits) would otherwise be started again every tick.
    assert recorded.launched == []
    assert svc.last_started['kiosk']['pid'] is None
    assert svc.last_started['kiosk']['clean_exit'] is True


def test_a_held_relaunch_comes_a_minute_later_and_spends_nothing(
        monkeypatch, an_always_on_entry, a_dead_pid):
    svc, recorded = _daemon_whose_process_ended(
        monkeypatch, a_dead_pid, code=0, ran_for=datetime.timedelta(seconds=5))
    svc.handle_process(an_always_on_entry)

    svc.current_time += datetime.timedelta(seconds=30)
    svc.handle_process(an_always_on_entry)
    assert recorded.launched == []

    svc.current_time += datetime.timedelta(seconds=31)
    svc.handle_process(an_always_on_entry)
    assert recorded.launched == [False]
    assert [e['action'] for e in recorded.events] == ['process_exited']


def test_a_failing_exit_code_is_a_crash_that_says_which(
        monkeypatch, an_always_on_entry, a_dead_pid):
    svc, recorded = _daemon_whose_process_ended(
        monkeypatch, a_dead_pid, code=3, ran_for=_AN_HOUR)

    svc.handle_process(an_always_on_entry)

    assert [e['action'] for e in recorded.events] == ['process_crash']
    assert recorded.events[0]['details'] == (
        f'Process stopped unexpectedly (PID {a_dead_pid}, exit code 3)')
    assert recorded.alerts == ['process_crash']
    assert recorded.launched == [True]


def test_an_exit_nobody_could_read_is_a_crash_as_before(
        monkeypatch, an_always_on_entry, a_dead_pid):
    """A process the daemon adopted after a restart is not its child on
    Linux, so how it ended is unknowable: that stays the crash it always was."""
    svc, recorded = _daemon_whose_process_ended(
        monkeypatch, a_dead_pid, code=None, ran_for=_AN_HOUR)

    svc.handle_process(an_always_on_entry)

    assert recorded.events[0]['details'] == (
        f'Process stopped unexpectedly (PID {a_dead_pid} no longer running)')
    assert recorded.alerts == ['process_crash']
    assert recorded.launched == [True]


def _budgeted_daemon(monkeypatch, *, attempts, gate_until=0.0):
    """reached_max_relaunch_attempts' service, three attempts configured."""
    notified = []
    monkeypatch.setattr(
        shared_utils, 'read_config',
        lambda keys=None, process_list_id=None: 3 if keys == ['relaunch_attempts'] else {})
    monkeypatch.setattr(
        shared_utils, 'fetch_process_id_by_name', lambda name, data: 'kiosk')
    svc = SimpleNamespace(
        first_start=False,
        relaunch_attempts={'Kiosk': attempts},
        _restart_prompt_until=gate_until,
        _seat_absent=lambda: False,
        _seatless_entries=set(),
        firebase_client=None,
        log_and_notify=lambda process, reason: notified.append(reason),
        launch_desktop_app_as_user=lambda *args: pytest.fail(
            'escalated a process that never crashed'),
    )
    svc._is_restart_prompt_active = _bound('_is_restart_prompt_active', svc)
    return _bound('reached_max_relaunch_attempts', svc), svc, notified


def test_a_finished_run_spends_no_relaunch_budget(monkeypatch):
    # one attempt past a budget of three: any crash here escalates.
    reached, svc, notified = _budgeted_daemon(monkeypatch, attempts=4)

    assert reached({'id': 'kiosk', 'name': 'Kiosk'}, after_crash=False) is False
    assert notified == []
    assert svc.relaunch_attempts == {'Kiosk': 4}


def test_an_armed_restart_gate_still_holds_a_finished_run(monkeypatch):
    reached, _, _ = _budgeted_daemon(
        monkeypatch, attempts=1, gate_until=float('inf'))

    assert reached({'id': 'kiosk', 'name': 'Kiosk'}, after_crash=False) is True


def test_every_launch_is_watched_for_its_exit(monkeypatch, tmp_path):
    """On Windows the service is not the process's parent, so its exit code is
    readable only through a handle taken while it runs."""
    watched = []
    monkeypatch.setattr(osadapter, 'watch_exit', watched.append)
    monkeypatch.setattr(
        shared_utils, 'RESULT_FILE_PATH', str(tmp_path / 'app_states.json'))
    svc = SimpleNamespace()

    _bound('_record_launch', svc)({'id': 'kiosk', 'name': 'Kiosk'}, os.getpid())

    assert watched == [os.getpid()]


def test_an_adopted_process_is_watched_on_the_first_tick_that_sees_it(
        monkeypatch, an_always_on_entry):
    """Adopted after a service restart, it was never launched through
    _record_launch, and on Windows only a watch lets its exit be read."""
    watched = []
    monkeypatch.setattr(osadapter, 'watch_exit', watched.append)
    monkeypatch.setattr(
        shared_utils, 'update_process_status_in_json', lambda *args, **kwargs: None)
    now = datetime.datetime.now()
    svc = SimpleNamespace(
        install_locks={},
        first_start=False,
        current_time=now,
        last_started={'kiosk': {'pid': os.getpid(), 'time': now - _AN_HOUR}},
        firebase_client=None,
        launch_python_script_as_user=lambda *args: None,
        handle_unresponsive_process=lambda pid, process: None,
    )

    _bound('handle_process', svc)(an_always_on_entry)

    assert watched == [os.getpid()]
