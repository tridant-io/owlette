"""A reboot deferred until active hours end ("restart when active hours end").

Held as reboot_state's deferredReboot and shown as rebootDeferredUntil, fired
at the window's end through the scheduled-fire path, held again when the
machine is inside the window once more, and dropped by a cancel or by a boot
since it was asked for. Never an attempt, which would hold the connection
watchdog off.

The window osadapter reads, the machine's clock, its boot time and
reboot_state's file are all pinned, so every case reads the same at any time
of day on any machine.
"""

import datetime
import json
import logging
import sys
import threading
import time
from types import SimpleNamespace
from unittest.mock import MagicMock

import pytest

import connection_manager
import owlette_service
import reboot_state
import shared_utils
import watchdog_state

WORKDAY = {'start': 8, 'end': 17, 'source': 'default'}
LATE = {'start': 8, 'end': 20, 'source': 'policy'}
MONDAY_1030 = datetime.datetime(2026, 10, 26, 10, 30)
MONDAY_1659 = datetime.datetime(2026, 10, 26, 16, 59)
MONDAY_1700 = datetime.datetime(2026, 10, 26, 17, 0)
TUESDAY_0900 = datetime.datetime(2026, 10, 27, 9, 0)
MONDAY_END = int(MONDAY_1700.timestamp())
ASKED = int(MONDAY_1030.timestamp())
BOOTED_BEFORE = int(datetime.datetime(2026, 10, 26, 7, 0).timestamp())
HELD_NOTICE = 'owlette: restart held until active hours ended — cancellable from dashboard'


@pytest.fixture(autouse=True)
def state_file(monkeypatch, tmp_path):
    """reboot_state on a file of this test's own."""
    path = tmp_path / 'reboot_state.json'
    monkeypatch.setattr(reboot_state, 'STATE_PATH', str(path))
    return path


@pytest.fixture
def machine(monkeypatch):
    """Pin the platform, the window osadapter reads and the machine's clock;
    pin again to move the clock."""
    def pin(window, now, platform='win32'):
        class Clock(datetime.datetime):
            @classmethod
            def now(cls, tz=None):
                return now if tz is None else now.astimezone(tz)

        # the adapter before the platform: resolving it under a borrowed
        # platform would import that platform's arm
        monkeypatch.setattr(owlette_service.osadapter, 'active_hours', lambda: window)
        monkeypatch.setattr(sys, 'platform', platform)
        monkeypatch.setattr(owlette_service, 'datetime', SimpleNamespace(
            datetime=Clock, timezone=datetime.timezone, timedelta=datetime.timedelta))

    return pin


@pytest.fixture
def os_verbs(monkeypatch):
    """The reboots the OS was asked for, with the notice and the thread that
    asked."""
    issued = SimpleNamespace(reboot=[], notices=[], threads=[], cancels=0)

    def reboot(delay, message=None):
        issued.reboot.append(delay)
        issued.notices.append(message)
        issued.threads.append(threading.current_thread().name)

    def cancel_reboot():
        issued.cancels += 1
        return True

    monkeypatch.setattr(owlette_service.osadapter, 'reboot', reboot)
    monkeypatch.setattr(owlette_service.osadapter, 'cancel_reboot', cancel_reboot)
    monkeypatch.setattr(owlette_service.session_state, 'set_intent', lambda intent: None)
    monkeypatch.setattr(owlette_service, 'REBOOT_ANNOUNCE_PREROLL_SECONDS', 0)
    return issued


@pytest.fixture
def booted(monkeypatch):
    def pin(at):
        monkeypatch.setattr(owlette_service.psutil, 'boot_time', lambda: at)
    pin(BOOTED_BEFORE)
    return pin


class RecordingClient:
    """The cloud client calls the deferral makes, recorded."""

    def __init__(self):
        self.logged = []
        self.flags = []
        self.pending_cleared = 0

    def log_event(self, action, level, process_name=None, details=None,
                  user_id=None, extra_fields=None):
        self.logged.append({'action': action, 'level': level, 'details': details,
                            'user_id': user_id, 'extra_fields': extra_fields})

    def actions(self):
        return [entry['action'] for entry in self.logged]

    def set_machine_flags(self, flags):
        self.flags.append(flags)

    def mirror_reboot_state(self, state):
        pass

    def clear_reboot_pending(self):
        self.pending_cleared += 1

    def is_connected(self):
        return True


def make_service(client):
    service = object.__new__(owlette_service.OwletteService)
    service.firebase_client = client
    service._shutting_down = False
    service._reboot_attempt_started_monotonic = None
    service._deferred_reboot_thread = None
    service.relaunch_attempts = {}
    service._restart_prompt_until = 0.0
    return service


def after_active_hours(**fields):
    return {'type': 'reboot_machine', 'when': 'after_active_hours',
            'queuedBy': 'user:u2', **fields}


def held():
    return reboot_state.read_state()['deferredReboot']


def tick(service):
    """One reboot-check tick's deferred half, and the fire it starts."""
    service._check_deferred_reboot()
    if service._deferred_reboot_thread is not None:
        service._deferred_reboot_thread.join(timeout=5)
        assert not service._deferred_reboot_thread.is_alive()


# asking for it

def test_inside_active_hours_the_reboot_waits_for_their_end(machine, os_verbs):
    machine(WORKDAY, MONDAY_1030)
    client = RecordingClient()
    service = make_service(client)

    result = service._handle_reboot_machine(after_active_hours())

    # completed, not failed: nothing was refused
    assert result == 'Reboot deferred until 17:00 (machine time)'
    assert os_verbs.reboot == []
    assert service._shutting_down is False
    assert held() == {'at': MONDAY_END, 'queuedBy': 'user:u2', 'requestedAt': ASKED}
    assert client.flags == [{'rebootDeferredUntil': MONDAY_END}]
    assert client.logged == [{
        'action': 'reboot_deferred',
        'level': 'info',
        'details': 'reboot deferred until 17:00 (machine time): inside active hours 08:00–17:00',
        'user_id': 'user:u2',
        'extra_fields': {'queuedBy': 'user:u2', 'window': WORKDAY,
                         'deferredUntil': MONDAY_END},
    }]


@pytest.mark.parametrize('now,platform', [
    (MONDAY_1700, 'win32'),  # the end hour is outside
    (MONDAY_1030, 'linux'),  # no active hours off Windows
])
def test_outside_active_hours_it_restarts_now_and_says_so(machine, os_verbs, now, platform):
    machine(WORKDAY, now, platform=platform)
    client = RecordingClient()

    result = make_service(client)._handle_reboot_machine(after_active_hours())

    assert result == (f'Reboot scheduled in {owlette_service.REBOOT_OS_COUNTDOWN_SECONDS} '
                      'seconds (not inside active hours)')
    assert os_verbs.reboot == [owlette_service.REBOOT_OS_COUNTDOWN_SECONDS]
    assert held() is None
    assert client.actions() == ['command_executed']


def test_asking_again_keeps_one_deferral(machine, os_verbs, state_file):
    machine(WORKDAY, MONDAY_1030)
    service = make_service(RecordingClient())
    service._handle_reboot_machine(after_active_hours())

    machine(LATE, datetime.datetime(2026, 10, 26, 11, 0))
    service._handle_reboot_machine(after_active_hours(queuedBy='apiKey:k1'))

    # the later request replaces the first, at the window now in force, and
    # neither is an attempt
    assert json.loads(state_file.read_text()) == {
        'lastFiredByEntry': {},
        'attempt': None,
        'deferredReboot': {
            'at': int(datetime.datetime(2026, 10, 26, 20, 0).timestamp()),
            'queuedBy': 'apiKey:k1',
            'requestedAt': int(datetime.datetime(2026, 10, 26, 11, 0).timestamp()),
        },
    }


# firing it

def test_it_fires_when_active_hours_end(machine, os_verbs, booted):
    machine(WORKDAY, MONDAY_1030)
    client = RecordingClient()
    service = make_service(client)
    service._handle_reboot_machine(after_active_hours())
    client.flags.clear()
    client.logged.clear()

    machine(WORKDAY, MONDAY_1659)
    tick(service)
    assert os_verbs.reboot == []
    assert held() is not None

    machine(WORKDAY, MONDAY_1700)
    tick(service)

    # off the main loop, through the scheduled-fire path
    assert os_verbs.reboot == [owlette_service.REBOOT_OS_COUNTDOWN_SECONDS]
    assert os_verbs.threads == ['deferred-reboot']
    assert held() is None
    assert reboot_state.read_state()['attempt'] is None
    assert service._shutting_down is True
    target = (MONDAY_END + owlette_service.REBOOT_ANNOUNCE_PREROLL_SECONDS
              + owlette_service.REBOOT_OS_COUNTDOWN_SECONDS)
    # the countdown takes over from the hold in one write
    assert client.flags == [{
        'rebootScheduledAt': target,
        'rebooting': True,
        'rebootSource': 'deferred',
        'rebootCancellable': True,
        'rebootEntryId': None,
        'rebootDeferredUntil': None,
    }]
    # its own notice and log action: in the schedule's words it read as a
    # weekly restart on a machine with none
    assert os_verbs.notices == [HELD_NOTICE]
    assert client.actions() == ['deferred_reboot_announced']
    assert client.logged[0]['details'].endswith('(deferred)')

    tick(service)
    assert len(os_verbs.reboot) == 1


def test_a_failed_fire_is_not_retried(machine, os_verbs, monkeypatch):
    machine(WORKDAY, MONDAY_1030)
    client = RecordingClient()
    service = make_service(client)
    service._handle_reboot_machine(after_active_hours())

    def refuse(delay, message=None):
        raise OSError('shutdown refused')

    monkeypatch.setattr(owlette_service.osadapter, 'reboot', refuse)
    machine(WORKDAY, MONDAY_1700)
    tick(service)

    assert service._shutting_down is False
    assert held() is None
    assert reboot_state.read_state()['lastFiredByEntry'] == {}
    assert client.flags[-1] == {'rebooting': False, 'rebootScheduledAt': None,
                                'rebootCancellable': False}
    assert client.actions()[-1] == 'deferred_reboot_failed'


def test_a_scheduled_fire_keeps_the_schedules_words(machine, os_verbs, monkeypatch):
    machine(WORKDAY, MONDAY_1700)
    client = RecordingClient()
    service = make_service(client)
    due = MONDAY_1700.astimezone()

    service._fire_scheduled_reboot(reboot_state.read_state(), 'entry-12345678', due)

    assert os_verbs.notices == ['Owlette scheduled reboot — cancellable from dashboard']
    assert client.actions() == ['scheduled_reboot_announced']

    def refuse(delay, message=None):
        raise OSError('shutdown refused')

    monkeypatch.setattr(owlette_service.osadapter, 'reboot', refuse)
    service._fire_scheduled_reboot(reboot_state.read_state(), 'entry-12345678', due)

    assert client.actions()[-1] == 'scheduled_reboot_failed'


@pytest.mark.parametrize('window,now,ends', [
    # the window moved later before it ended
    (LATE, MONDAY_1700, datetime.datetime(2026, 10, 26, 20, 0)),
    # the service was down through the end and back inside the next window
    (WORKDAY, TUESDAY_0900, datetime.datetime(2026, 10, 27, 17, 0)),
])
def test_inside_the_window_again_it_is_held_to_the_next_end(
        machine, os_verbs, booted, window, now, ends):
    machine(WORKDAY, MONDAY_1030)
    client = RecordingClient()
    service = make_service(client)
    service._handle_reboot_machine(after_active_hours())
    client.flags.clear()
    client.logged.clear()

    machine(window, now)
    tick(service)

    assert os_verbs.reboot == []
    # the same request, held longer
    assert held() == {'at': int(ends.timestamp()), 'queuedBy': 'user:u2', 'requestedAt': ASKED}
    assert client.flags == [{'rebootDeferredUntil': int(ends.timestamp())}]
    assert client.actions() == ['reboot_deferred']


def test_a_countdown_already_running_holds_the_fire(machine, os_verbs):
    machine(WORKDAY, MONDAY_1030)
    service = make_service(RecordingClient())
    service._handle_reboot_machine(after_active_hours())

    service._shutting_down = True
    machine(WORKDAY, MONDAY_1700)
    tick(service)

    assert os_verbs.reboot == []
    assert held() is not None


# a service restart, a boot, a cancel, a schedule edit

def test_it_survives_a_service_restart(machine, os_verbs, booted):
    machine(WORKDAY, MONDAY_1030)
    make_service(RecordingClient())._handle_reboot_machine(after_active_hours())

    client = RecordingClient()
    restarted = make_service(client)
    restarted._resume_deferred_reboot()

    assert held()['at'] == MONDAY_END
    assert client.flags == [{'rebootDeferredUntil': MONDAY_END}]

    machine(WORKDAY, MONDAY_1700)
    tick(restarted)
    assert os_verbs.reboot == [owlette_service.REBOOT_OS_COUNTDOWN_SECONDS]


def test_a_boot_since_it_was_asked_for_fulfils_it(machine, os_verbs, booted):
    machine(WORKDAY, MONDAY_1030)
    make_service(RecordingClient())._handle_reboot_machine(after_active_hours())

    booted(int(datetime.datetime(2026, 10, 26, 12, 0).timestamp()))
    client = RecordingClient()
    rebooted = make_service(client)
    rebooted._resume_deferred_reboot()

    assert held() is None
    # the startup clear already dropped the flag; nothing says it again
    assert client.flags == []

    machine(WORKDAY, MONDAY_1700)
    tick(rebooted)
    assert os_verbs.reboot == []


def test_cancel_drops_it_and_its_flag(machine, os_verbs):
    machine(WORKDAY, MONDAY_1030)
    client = RecordingClient()
    service = make_service(client)
    service._handle_reboot_machine(after_active_hours())

    service._handle_cancel_reboot({'type': 'cancel_reboot'})

    assert held() is None
    assert client.flags[-1]['rebootDeferredUntil'] is None
    machine(WORKDAY, MONDAY_1700)
    tick(service)
    assert os_verbs.reboot == []


def test_a_schedule_edit_keeps_it(machine, os_verbs, monkeypatch, tmp_path):
    machine(WORKDAY, MONDAY_1030)
    make_service(RecordingClient())._handle_reboot_machine(after_active_hours())
    state = reboot_state.read_state()
    state['attempt'] = {'entryId': 'entry-1', 'status': 'pending'}
    reboot_state.write_state(state)

    old_config = {'processes': [], 'firebase': {'enabled': False},
                  'rebootSchedule': {'enabled': True, 'entries': [
                      {'id': 'entry-1', 'days': ['mon'], 'time': '03:00'}]}}
    monkeypatch.setattr(shared_utils, 'read_config', lambda *a, **kw: old_config)
    monkeypatch.setattr(shared_utils, 'CONFIG_PATH', str(tmp_path / 'config.json'))
    monkeypatch.setattr(owlette_service.config_sync, 'configs_equal', lambda a, b: False)
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
        setattr(svc, name, getattr(owlette_service.OwletteService, name).__get__(
            svc, owlette_service.OwletteService))

    svc.handle_config_update({'processes': [],
                              'rebootSchedule': {'enabled': False, 'entries': []}})

    # the edit supersedes the scheduler's attempt, and only that
    assert reboot_state.read_state()['attempt'] is None
    assert held() == {'at': MONDAY_END, 'queuedBy': 'user:u2', 'requestedAt': ASKED}


def test_pruning_schedule_entries_keeps_it():
    state = {'lastFiredByEntry': {'gone': '2026-10-25'}, 'attempt': None,
             'deferredReboot': {'at': MONDAY_END, 'queuedBy': 'user:u2', 'requestedAt': ASKED}}

    reboot_state.write_state(reboot_state.prune_orphaned_entries(state, set()))

    assert reboot_state.read_state() == {
        'lastFiredByEntry': {},
        'attempt': None,
        'deferredReboot': {'at': MONDAY_END, 'queuedBy': 'user:u2', 'requestedAt': ASKED},
    }


@pytest.mark.parametrize('deferred', [
    'tonight', {'queuedBy': 'user:u2'}, {'at': '17:00', 'requestedAt': ASKED},
    {'at': MONDAY_END}, ['at', MONDAY_END],
])
def test_a_misshapen_deferral_on_disk_reads_as_none(state_file, deferred):
    state_file.write_text(json.dumps(
        {'lastFiredByEntry': {}, 'attempt': None, 'deferredReboot': deferred}))

    assert held() is None


# the crash loop's deferral and its dismiss

@pytest.mark.parametrize('queued_by,kept', [
    (owlette_service._CRASH_LOOP_QUEUED_BY, False),
    ('user:u2', True),
])
def test_dismissing_the_crash_loop_reboot_drops_only_its_deferral(
        machine, os_verbs, queued_by, kept):
    machine(WORKDAY, MONDAY_1030)
    client = RecordingClient()
    service = make_service(client)
    service._defer_reboot(WORKDAY, MONDAY_1030, queued_by)
    client.flags.clear()

    service._handle_dismiss_reboot_pending({'process_name': 'Kiosk'})

    assert client.pending_cleared == 1
    assert (held() is not None) is kept
    assert client.flags == ([] if kept else [{'rebootDeferredUntil': None}])


# the connection watchdog

def test_a_deferral_never_holds_the_connection_watchdog_off(
        machine, os_verbs, monkeypatch, tmp_path):
    machine(WORKDAY, MONDAY_1030)
    make_service(RecordingClient())._handle_reboot_machine(after_active_hours())
    assert reboot_state.read_state()['attempt'] is None

    monkeypatch.setattr(watchdog_state, 'BUDGET_PATH', str(tmp_path / 'budget.json'))
    monkeypatch.setattr(watchdog_state, 'HISTORY_PATH', str(tmp_path / 'history.json'))
    # the watchdog's own lazy import finds this reboot_state
    monkeypatch.setitem(sys.modules, 'reboot_state', reboot_state)
    manager = connection_manager.ConnectionManager(logging.getLogger('test_deferred_reboot'))
    monkeypatch.setattr(manager, '_read_watchdog_config', lambda: {
        'enabled': True,
        'thresholds': {'failure_seconds': 1, 'boot_grace_seconds': 0},
        'budget': {'max_per_window': 3, 'window_seconds': 3600},
        'preconditions': {'require_internet': True, 'fatal_error_suppression_seconds': 3600},
    })
    monkeypatch.setattr(manager, '_check_internet', lambda: True)
    restart = MagicMock()
    manager.set_restart_callback(restart)
    manager._process_start_time_mono = time.monotonic() - 5.0

    manager._check_self_restart()

    assert restart.called, 'a held deferral stopped the watchdog restarting a stuck agent'
