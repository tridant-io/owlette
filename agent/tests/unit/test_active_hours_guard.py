"""The active-hours guard: inside the machine's active hours the agent refuses
a reboot, a shutdown or a deployment unless a person overrode it (ADR 0013).

Windows only. The window osadapter reads and owlette_service's clock are both
pinned here, so every case gets one answer at any time of day on any platform.
"""

import datetime
import logging
import sys
import time
from types import SimpleNamespace
from unittest.mock import MagicMock

import pytest

import firebase_client
import mcp_tools
import owlette_service
import reboot_state
import shared_utils

WORKDAY = {'start': 8, 'end': 17, 'source': 'default'}
OVERNIGHT = {'start': 22, 'end': 6, 'source': 'policy'}
MONDAY_1030 = datetime.datetime(2026, 10, 26, 10, 30)
OVERRIDE = {'reason': 'swap the projector before doors', 'approvedBy': 'user:u1'}
REFUSAL = ('Error: active_hours: inside active hours 08:00–17:00 (machine time); '
           'they end at 17:00')


@pytest.fixture
def machine(monkeypatch):
    """Pin the platform, the window osadapter reads and the machine's clock.

    A window that is an exception is raised by the read. Returns the list of
    reads, so a case can show the window was never asked for.
    """
    reads = []

    def pin(window, now=MONDAY_1030, platform='win32'):
        def read():
            reads.append(window)
            if isinstance(window, Exception):
                raise window
            return window

        class Clock(datetime.datetime):
            @classmethod
            def now(cls, tz=None):
                return now if tz is None else now.astimezone(tz)

        # the adapter before the platform: resolving it under a borrowed
        # platform would import that platform's arm
        monkeypatch.setattr(owlette_service.osadapter, 'active_hours', read)
        monkeypatch.setattr(sys, 'platform', platform)
        monkeypatch.setattr(owlette_service, 'datetime', SimpleNamespace(
            datetime=Clock, timezone=datetime.timezone, timedelta=datetime.timedelta))
        return reads

    return pin


@pytest.fixture
def os_verbs(monkeypatch):
    """The reboot and shutdown the OS was asked for, and the intents written."""
    issued = SimpleNamespace(reboot=[], shutdown=[], intents=[])
    monkeypatch.setattr(owlette_service.osadapter, 'reboot',
                        lambda delay, message=None: issued.reboot.append(delay))
    monkeypatch.setattr(owlette_service.osadapter, 'shutdown',
                        lambda delay, message=None: issued.shutdown.append(delay))
    monkeypatch.setattr(owlette_service.session_state, 'set_intent', issued.intents.append)
    return issued


class RecordingClient:
    """The cloud client calls the guarded paths make, recorded."""

    def __init__(self):
        self.logged = []
        self.flags = []
        self.pending = []

    def log_event(self, action, level, process_name=None, details=None,
                  user_id=None, extra_fields=None):
        self.logged.append({'action': action, 'level': level, 'details': details,
                            'user_id': user_id, 'extra_fields': extra_fields})

    def actions(self):
        return [entry['action'] for entry in self.logged]

    def set_machine_flags(self, flags):
        self.flags.append(flags)

    def set_reboot_pending(self, process_name, reason, timestamp):
        self.pending.append(process_name)
        return True

    def update_command_progress(self, cmd_id, status, deployment_id=None):
        pass

    def is_connected(self):
        return True


def make_service(client):
    service = object.__new__(owlette_service.OwletteService)
    service.firebase_client = client
    service._shutting_down = False
    service._command_rate_limits = {}
    service._command_router = SimpleNamespace(has_handler=lambda cmd_type: False)
    return service


def reboot(**fields):
    return {'type': 'reboot_machine', 'delay_seconds': 30, 'queuedBy': 'user:u2', **fields}


# the reboot and shutdown verbs

def test_a_reboot_inside_active_hours_is_refused_before_anything_moves(machine, os_verbs):
    machine(WORKDAY)
    client = RecordingClient()
    service = make_service(client)

    result = service._handle_reboot_machine(reboot())

    # the Error: prefix is what finish_command records as failed
    assert result == REFUSAL
    assert os_verbs.reboot == []
    assert os_verbs.intents == []
    assert client.flags == []
    assert service._shutting_down is False
    assert client.logged == [{
        'action': 'active_hours_refused',
        'level': 'info',
        'details': 'reboot_machine refused inside active hours 08:00–17:00 (machine time)',
        'user_id': 'user:u2',
        'extra_fields': {'commandType': 'reboot_machine', 'queuedBy': 'user:u2',
                         'window': WORKDAY},
    }]


def test_a_shutdown_inside_active_hours_is_refused(machine, os_verbs):
    machine(WORKDAY)
    client = RecordingClient()

    result = make_service(client)._handle_shutdown_machine({'type': 'shutdown_machine'})

    assert result == REFUSAL
    assert os_verbs.shutdown == []
    assert client.flags == []
    assert client.actions() == ['active_hours_refused']


def test_an_override_reboots_and_says_who_approved_it_and_why(machine, os_verbs):
    machine(WORKDAY)
    client = RecordingClient()

    result = make_service(client)._handle_reboot_machine(
        reboot(activeHoursOverride=OVERRIDE))

    assert result == f'Reboot scheduled in {owlette_service.REBOOT_OS_COUNTDOWN_SECONDS} seconds'
    assert os_verbs.reboot == [owlette_service.REBOOT_OS_COUNTDOWN_SECONDS]
    assert client.actions() == ['active_hours_override', 'command_executed']
    override = client.logged[0]
    assert override['level'] == 'warning'
    assert override['user_id'] == 'user:u1'
    assert override['extra_fields'] == {
        'commandType': 'reboot_machine',
        'reason': 'swap the projector before doors',
        'approvedBy': 'user:u1',
        'queuedBy': 'user:u2',
        'window': WORKDAY,
    }


@pytest.mark.parametrize('override', [
    None,
    'swap the projector',
    {},
    {'reason': 'swap the projector'},
    {'reason': '', 'approvedBy': 'user:u1'},
    {'reason': '   ', 'approvedBy': 'user:u1'},
    {'reason': 'x' * 501, 'approvedBy': 'user:u1'},
    {'reason': 'swap the projector', 'approvedBy': ''},
    {'reason': 'swap the projector', 'approvedBy': 7},
    {'reason': ['swap the projector'], 'approvedBy': 'user:u1'},
])
def test_only_a_whole_override_counts(machine, os_verbs, override):
    machine(WORKDAY)

    result = make_service(RecordingClient())._handle_reboot_machine(
        reboot(activeHoursOverride=override))

    assert result == REFUSAL
    assert os_verbs.reboot == []


def test_a_500_character_reason_is_still_an_override(machine, os_verbs):
    machine(WORKDAY)

    make_service(RecordingClient())._handle_reboot_machine(
        reboot(activeHoursOverride={'reason': 'x' * 500, 'approvedBy': 'apiKey:k1'}))

    assert os_verbs.reboot == [owlette_service.REBOOT_OS_COUNTDOWN_SECONDS]


def test_outside_active_hours_a_reboot_is_unchanged(machine, os_verbs):
    machine(WORKDAY, now=datetime.datetime(2026, 10, 26, 17, 0))  # the end hour is outside
    client = RecordingClient()

    make_service(client)._handle_reboot_machine(reboot())

    assert os_verbs.reboot == [owlette_service.REBOOT_OS_COUNTDOWN_SECONDS]
    assert client.actions() == ['command_executed']


@pytest.mark.parametrize('platform', ['linux', 'darwin'])
def test_off_windows_nothing_is_guarded(machine, os_verbs, platform):
    reads = machine(WORKDAY, platform=platform)
    client = RecordingClient()

    make_service(client)._handle_reboot_machine(reboot())

    assert os_verbs.reboot == [owlette_service.REBOOT_OS_COUNTDOWN_SECONDS]
    assert reads == []
    assert client.actions() == ['command_executed']


def test_an_unreadable_window_holds_nothing_back(machine, os_verbs, caplog):
    machine(OSError('registry unavailable'))

    with caplog.at_level(logging.WARNING):
        make_service(RecordingClient())._handle_reboot_machine(reboot())

    assert os_verbs.reboot == [owlette_service.REBOOT_OS_COUNTDOWN_SECONDS]
    assert 'registry unavailable' in caplog.text


@pytest.mark.parametrize('now,ends', [
    (datetime.datetime(2026, 10, 26, 23, 30), '06:00'),
    (datetime.datetime(2026, 10, 27, 1, 0), '06:00'),
])
def test_a_window_past_midnight_names_its_own_end(machine, os_verbs, now, ends):
    machine(OVERNIGHT, now=now)

    result = make_service(RecordingClient())._handle_reboot_machine(reboot())

    assert result == ('Error: active_hours: inside active hours 22:00–06:00 '
                      f'(machine time); they end at {ends}')


# deployments

def install(**fields):
    return {
        'type': 'install_software',
        'installer_url': 'https://example.invalid/app.exe',
        'installer_name': 'app.exe',
        'sha256_checksum': 'ab' * 32,
        'close_processes': ['TouchDesigner.exe'],
        'suppress_projects': ['proc-1'],
        'deployment_id': 'dep-1',
        **fields,
    }


@pytest.fixture
def downloads(monkeypatch, tmp_path):
    """Downloads asked for; each fails, so a deployment that gets this far ends."""
    asked = []
    monkeypatch.setattr(owlette_service.installer_utils, 'get_temp_installer_path',
                        lambda name: str(tmp_path / name))
    monkeypatch.setattr(owlette_service.installer_utils, 'download_file',
                        lambda url, path: asked.append(url) or (False, path))
    monkeypatch.setattr(owlette_service.installer_utils, 'cleanup_installer',
                        lambda path, force=False: True)
    return asked


def test_a_deployment_inside_active_hours_stops_nothing(machine, downloads):
    machine(WORKDAY)
    client = RecordingClient()
    service = make_service(client)
    service._terminate_processes_for_install = MagicMock(return_value=[])

    result = service.handle_firebase_command('cmd-1', install())

    assert result == REFUSAL
    service._terminate_processes_for_install.assert_not_called()
    assert downloads == []
    assert client.actions() == ['active_hours_refused']


def test_a_deployment_with_an_override_closes_its_processes_and_proceeds(machine, downloads):
    machine(WORKDAY)
    client = RecordingClient()
    service = make_service(client)
    service._terminate_processes_for_install = MagicMock(return_value=[])

    service.handle_firebase_command('cmd-1', install(activeHoursOverride=OVERRIDE))

    service._terminate_processes_for_install.assert_called_once()
    assert downloads == ['https://example.invalid/app.exe']
    assert client.actions() == ['active_hours_override']


# hoot's tools get the override; manage_windows_update is the one that reads it

def test_an_mcp_tool_call_hands_its_override_to_the_tool(monkeypatch):
    calls = []

    def execute_tool(tool_name, tool_params, config, command_id=None,
                     active_hours_override=None):
        calls.append((tool_name, command_id, active_hours_override))
        return {'ok': True}

    monkeypatch.setattr(mcp_tools, 'execute_tool', execute_tool)
    monkeypatch.setattr(shared_utils, 'read_config', lambda *a, **kw: {})
    service = make_service(RecordingClient())
    service._log_cortex_tool = lambda *args: None

    service.handle_firebase_command('cmd-1', {
        'type': 'mcp_tool_call', 'tool_name': 'manage_windows_update',
        'tool_params': {'action': 'set_active_hours'}, 'activeHoursOverride': OVERRIDE})
    service.handle_firebase_command('cmd-2', {
        'type': 'mcp_tool_call', 'tool_name': 'manage_windows_update',
        'tool_params': {'action': 'get_status'}})

    assert calls == [('manage_windows_update', 'cmd-1', OVERRIDE),
                     ('manage_windows_update', 'cmd-2', None)]


def run_tool(monkeypatch, client, tool_name, result, **fields):
    """An mcp_tool_call whose tool answers `result`."""
    monkeypatch.setattr(mcp_tools, 'execute_tool', lambda *args, **kwargs: result)
    monkeypatch.setattr(shared_utils, 'read_config', lambda *a, **kw: {})
    service = make_service(client)
    service._log_cortex_tool = lambda *args: None
    return service.handle_firebase_command('cmd-1', {
        'type': 'mcp_tool_call', 'tool_name': tool_name,
        'activeHoursOverride': OVERRIDE, 'queuedBy': 'user:u2', **fields})


def test_an_override_the_tool_used_is_logged_like_a_reboots(monkeypatch):
    """set_active_hours and limit_auto_restart say when moving the machine out
    of its active hours took the override; the site log gets the same row a
    reboot's override writes."""
    client = RecordingClient()

    run_tool(monkeypatch, client, 'manage_windows_update', {
        'status': 'ok', 'active_hours': {'start': 18, 'end': 23, 'source': 'policy'},
        'override_used': True, 'previous_active_hours': WORKDAY,
    }, tool_params={'action': 'Set_Active_Hours', 'start_hour': 18, 'end_hour': 23})

    assert client.logged == [{
        'action': 'active_hours_override',
        'level': 'warning',
        'details': ('manage_windows_update:set_active_hours inside active hours '
                    '08:00–17:00 (machine time): swap the projector before doors'),
        'user_id': 'user:u1',
        'extra_fields': {
            'commandType': 'manage_windows_update:set_active_hours',
            'reason': 'swap the projector before doors',
            'approvedBy': 'user:u1',
            'queuedBy': 'user:u2',
            'window': WORKDAY,
        },
    }]


@pytest.mark.parametrize('tool_name, result', [
    ('manage_windows_update', {'status': 'ok'}),
    ('manage_windows_update', {'error': 'active_hours: inside active hours 08:00–17:00'}),
    ('registry_operation', {'status': 'ok', 'override_used': True,
                            'previous_active_hours': WORKDAY}),
], ids=['not-needed', 'refused', 'another-tool'])
def test_an_override_the_tool_did_not_use_is_not_logged(monkeypatch, tool_name, result):
    client = RecordingClient()

    run_tool(monkeypatch, client, tool_name, result,
             tool_params={'action': 'set_active_hours', 'start_hour': 7, 'end_hour': 23})

    assert client.logged == []


# the crash-loop reboot

def crash_looping_service(client):
    """Four crashes against a budget of three: the next one escalates."""
    notes = []
    service = SimpleNamespace(
        first_start=False,
        relaunch_attempts={'Kiosk': 4},
        _restart_prompt_until=0.0,
        _seat_absent=lambda: False,
        _seatless_entries=set(),
        firebase_client=client,
        log_and_notify=lambda process, reason: notes.append(reason),
        launch_desktop_app_as_user=MagicMock(return_value=True),
        notes=notes,
    )
    for name in ('reached_max_relaunch_attempts', '_is_restart_prompt_active', '_defer_reboot'):
        setattr(service, name, getattr(owlette_service.OwletteService, name).__get__(
            service, owlette_service.OwletteService))
    return service


@pytest.fixture
def budget_of_three(monkeypatch, tmp_path):
    monkeypatch.setattr(shared_utils, 'read_config',
                        lambda keys=None, process_list_id=None:
                        3 if keys == ['relaunch_attempts'] else {})
    monkeypatch.setattr(shared_utils, 'fetch_process_id_by_name', lambda name, data: 'kiosk')
    # where a held reboot is deferred to
    monkeypatch.setattr(reboot_state, 'STATE_PATH', str(tmp_path / 'reboot_state.json'))


def test_a_crash_loop_inside_active_hours_defers_the_reboot(machine, budget_of_three):
    machine(WORKDAY)
    client = RecordingClient()
    service = crash_looping_service(client)

    assert service.reached_max_relaunch_attempts({'id': 'kiosk', 'name': 'Kiosk'}) is True

    # the dashboard still sees the pending reboot, and nothing counts down to
    # one: it waits for the window's end
    end = int(datetime.datetime(2026, 10, 26, 17, 0).timestamp())
    assert client.pending == ['Kiosk']
    service.launch_desktop_app_as_user.assert_not_called()
    assert reboot_state.read_state()['deferredReboot'] == {
        'at': end, 'queuedBy': 'system:crash_loop', 'requestedAt': int(MONDAY_1030.timestamp())}
    assert reboot_state.read_state()['attempt'] is None
    assert client.flags == [{'rebootDeferredUntil': end}]
    assert service.notes == [
        'Terminated Kiosk 3 times. Reboot deferred until 17:00: '
        'inside active hours 08:00–17:00 (machine time)']
    assert client.logged == [{
        'action': 'active_hours_refused',
        'level': 'info',
        'details': 'crash-loop reboot held inside active hours 08:00–17:00 (machine time)',
        'user_id': None,
        'extra_fields': {'queuedBy': 'system:crash_loop', 'window': WORKDAY},
    }, {
        'action': 'reboot_deferred',
        'level': 'info',
        'details': 'reboot deferred until 17:00 (machine time): inside active hours 08:00–17:00',
        'user_id': 'system:crash_loop',
        'extra_fields': {'queuedBy': 'system:crash_loop', 'window': WORKDAY,
                         'deferredUntil': end},
    }]
    # held for as long as a prompt would have been up, then a fresh budget
    assert time.monotonic() < service._restart_prompt_until <= (
        time.monotonic() + owlette_service.RESTART_PROMPT_ACTIVE_SECONDS)
    assert 'Kiosk' not in service.relaunch_attempts


@pytest.mark.parametrize('window,now', [
    (WORKDAY, datetime.datetime(2026, 10, 26, 20, 0)),
    (OSError('registry unavailable'), MONDAY_1030),
])
def test_a_crash_loop_outside_active_hours_opens_the_prompt(
        machine, budget_of_three, window, now):
    machine(window, now=now)
    client = RecordingClient()
    service = crash_looping_service(client)

    assert service.reached_max_relaunch_attempts({'id': 'kiosk', 'name': 'Kiosk'}) is True

    service.launch_desktop_app_as_user.assert_called_once()
    assert service.notes == ['Terminated Kiosk 3 times. System reboot imminent']
    assert client.logged == []


# the heartbeat

def heartbeat(monkeypatch, window, platform='win32'):
    """The dict one heartbeat hands the machine document's update()."""
    def read():
        if isinstance(window, Exception):
            raise window
        return window

    monkeypatch.setattr(firebase_client.osadapter, 'active_hours', read)
    monkeypatch.setattr(sys, 'platform', platform)
    monkeypatch.setattr(shared_utils, 'get_swoop_exe_path', lambda: None)
    fc = firebase_client.FirebaseClient.__new__(firebase_client.FirebaseClient)
    fc.db = MagicMock()
    fc.logger = MagicMock()
    fc.connection_manager = MagicMock()
    fc.connection_manager.is_connected = True
    fc.machine_id = 'kiosk-1'
    fc.site_id = 'site-1'
    fc._last_primary = None
    fc._ensure_profile = MagicMock(return_value=None)
    fc._ensure_display_profile = MagicMock(return_value=None)
    fc._display_drift_count = MagicMock(return_value=0)

    assert fc._upload_metrics({'memory': {}, 'processes': {}}) is True
    machine_ref = (fc.db.collection.return_value.document.return_value
                   .collection.return_value.document.return_value)
    return machine_ref.update.call_args[0][0]


def test_the_heartbeat_carries_the_window_and_the_guard(monkeypatch):
    payload = heartbeat(monkeypatch, {'start': 9, 'end': 23, 'source': 'policy'})

    assert payload['activeHours'] == {'start': 9, 'end': 23, 'source': 'policy'}
    # dotted, beside its siblings: a whole capabilities map would drop them
    assert payload['capabilities.activeHoursGuard'] == 1
    assert payload['capabilities.keepAwake'] == 1


@pytest.mark.parametrize('window', [None, OSError('registry unavailable')])
def test_no_window_deletes_the_field_and_the_heartbeat_still_lands(monkeypatch, window):
    payload = heartbeat(monkeypatch, window)

    assert payload['activeHours'] is firebase_client.DELETE_FIELD
    assert payload['capabilities.activeHoursGuard'] == 1


@pytest.mark.parametrize('platform', ['linux', 'darwin'])
def test_off_windows_the_heartbeat_claims_no_guard(monkeypatch, platform):
    payload = heartbeat(monkeypatch, None, platform=platform)

    assert payload['activeHours'] is firebase_client.DELETE_FIELD
    assert 'capabilities.activeHoursGuard' not in payload
