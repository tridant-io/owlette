"""manage_windows_update and check_pending_reboot against an in-memory registry.

Every test runs on a fake `winreg` patched into both tools_windows and the
osadapter Windows arm (which reads active hours back), and on a stubbed
`run_capture`, so nothing here reads or writes the machine's own registry or
runs a real command. The key paths are spelled out rather than read off the
module, so a write pointed at the wrong key fails here: owlette's deferral and
restart-deadline writes once went under AU, where Windows never reads them.
"""

import re
from datetime import datetime, timedelta, timezone
from types import SimpleNamespace

import pytest

import mcp_tools

pytestmark = pytest.mark.windows

P = r'SOFTWARE\Policies\Microsoft\Windows\WindowsUpdate'
AU = P + r'\AU'
UX = r'SOFTWARE\Microsoft\WindowsUpdate\UX\Settings'
UPS = r'SOFTWARE\Microsoft\WindowsUpdate\UpdatePolicy\Settings'
MDM = r'SOFTWARE\Microsoft\PolicyManager\current\device\Update'
MDM_CONFLICT = r'SOFTWARE\Microsoft\PolicyManager\current\device\ControlPolicyConflict'
REBOOT_REQUIRED = r'SOFTWARE\Microsoft\Windows\CurrentVersion\WindowsUpdate\Auto Update\RebootRequired'
CBS_REBOOT = r'SOFTWARE\Microsoft\Windows\CurrentVersion\Component Based Servicing\RebootPending'
SESSION_MANAGER = r'SYSTEM\CurrentControlSet\Control\Session Manager'

UX_PAUSE_VALUES = (
    'PauseUpdatesStartTime', 'PauseUpdatesExpiryTime',
    'PauseFeatureUpdatesStartTime', 'PauseFeatureUpdatesEndTime',
    'PauseQualityUpdatesStartTime', 'PauseQualityUpdatesEndTime',
)

# a wednesday afternoon, inside windows' default 8-17 and clear of any dst change
NOW = datetime(2026, 10, 21, 14, 0)

OVERRIDE = {'reason': 'venue closed for the day', 'approvedBy': 'user:u1'}


class _Registry:
    """HKLM in memory: `keys` maps a key path to its values, and every write
    and delete lands in `ops`, in order."""

    def __init__(self):
        self.keys = {}
        self.ops = []
        self.module = SimpleNamespace(
            HKEY_LOCAL_MACHINE=object(), KEY_READ=0x20019, KEY_WRITE=0x20006,
            REG_SZ=1, REG_EXPAND_SZ=2, REG_BINARY=3, REG_DWORD=4, REG_MULTI_SZ=7,
            OpenKey=self._open, CreateKey=self._create, QueryValueEx=self._query,
            SetValueEx=self._set, DeleteValue=self._delete, EnumValue=self._enum,
        )

    def set(self, path, **values):
        self.keys.setdefault(path, {}).update(values)

    def values(self, path):
        return self.keys.get(path, {})

    def writes(self, path=None):
        return [op[2:] for op in self.ops if op[0] == 'set' and path in (None, op[1])]

    def deletes(self, path=None):
        return [op[2] for op in self.ops if op[0] == 'delete' and path in (None, op[1])]

    def _hklm(self, root):
        # anything but HKLM is a key this module never meant to touch
        assert root is self.module.HKEY_LOCAL_MACHINE

    def _open(self, root, path, reserved=0, access=None):
        self._hklm(root)
        if path not in self.keys:
            raise FileNotFoundError(2, 'The system cannot find the file specified')
        return _Handle(path)

    def _create(self, root, path):
        self._hklm(root)
        self.keys.setdefault(path, {})
        return _Handle(path)

    def _query(self, handle, name):
        values = self.keys[handle.path]
        if name not in values:
            raise FileNotFoundError(2, 'The system cannot find the file specified')
        value = values[name]
        return value, 1 if isinstance(value, str) else 4

    def _set(self, handle, name, reserved, kind, value):
        self.keys[handle.path][name] = value
        self.ops.append(('set', handle.path, name, value, kind))

    def _delete(self, handle, name):
        values = self.keys[handle.path]
        if name not in values:
            raise FileNotFoundError(2, 'The system cannot find the file specified')
        del values[name]
        self.ops.append(('delete', handle.path, name))

    def _enum(self, handle, index):
        items = list(self.keys[handle.path].items())
        if index >= len(items):
            raise OSError(259, 'No more data is available')
        name, value = items[index]
        return name, value, 1 if isinstance(value, str) else 4


class _Handle:
    def __init__(self, path):
        self.path = path

    def __enter__(self):
        return self

    def __exit__(self, *exc_info):
        return False


def _frozen_clock(moment):
    class _Clock(datetime):
        @classmethod
        def now(cls, tz=None):
            return moment if tz is None else moment.astimezone(tz)
    return _Clock


@pytest.fixture
def tools_windows():
    import tools_windows
    return tools_windows


@pytest.fixture(autouse=True)
def registry(tools_windows, monkeypatch):
    """Autouse, so no test can reach the machine's real registry."""
    from osadapter import win

    reg = _Registry()
    monkeypatch.setattr(tools_windows, 'winreg', reg.module)
    monkeypatch.setattr(win, 'winreg', reg.module)
    return reg


@pytest.fixture(autouse=True)
def clock(tools_windows, monkeypatch):
    def at(moment):
        monkeypatch.setattr(tools_windows, 'datetime', _frozen_clock(moment))
    at(NOW)
    return at


@pytest.fixture(autouse=True)
def ran(monkeypatch):
    """Every command the tools would run, answered from canned replies; one
    with no reply fails the way a missing binary does."""
    recorder = SimpleNamespace(calls=[], replies=[])

    def run_capture(cmd, timeout=mcp_tools.SUBPROCESS_TIMEOUT, cwd=None):
        recorder.calls.append(list(cmd))
        joined = ' '.join(cmd)
        for match, result in recorder.replies:
            if match in joined:
                return result
        return -1, '', 'not stubbed'

    recorder.reply = lambda match, result: recorder.replies.append((match, result))
    monkeypatch.setattr(mcp_tools, 'run_capture', run_capture)
    return recorder


@pytest.fixture
def update(tools_windows):
    def call(action, override=None, **params):
        return tools_windows.manage_windows_update(
            {'action': action, **params}, None, active_hours_override=override)
    return call


# ─── get_status ─────────────────────────────────────────────────────────────


def test_status_reads_the_deferrals_where_windows_does(registry, update):
    """Windows reads Defer* from the policy key; the AU copies are owlette's
    old writes, which did nothing."""
    registry.set(P, DeferFeatureUpdatesPeriodInDays=30, DeferQualityUpdatesPeriodInDays=7)
    registry.set(AU, DeferFeatureUpdatesPeriodInDays=99, DeferQualityUpdatesPeriodInDays=99)

    status = update('get_status')

    assert status['feature_update_deferral_days'] == 30
    assert status['quality_update_deferral_days'] == 7


def test_status_names_the_window_in_force_and_the_machine_clock(registry, update):
    registry.set(UX, ActiveHoursStart=8, ActiveHoursEnd=2)
    registry.set(P, SetActiveHours=1, ActiveHoursStart=6, ActiveHoursEnd=22)

    status = update('get_status')

    assert status['active_hours'] == {'start': 6, 'end': 22, 'source': 'policy'}
    assert (status['active_hours_start'], status['active_hours_end']) == (6, 22)
    assert status['inside_active_hours_now'] is True
    assert status['machine_local_time'].startswith('2026-10-21T14:00')


def test_status_outside_the_window(clock, update):
    clock(datetime(2026, 10, 21, 20, 0))

    status = update('get_status')

    assert status['active_hours']['source'] == 'default'
    assert status['inside_active_hours_now'] is False


def test_status_reports_automatic_updates_and_warns_on_no_auto_reboot(registry, update):
    registry.set(AU, AUOptions=4, NoAutoUpdate=0, ScheduledInstallDay=3,
                 ScheduledInstallTime=3, ScheduledInstallEveryWeek=1,
                 NoAutoRebootWithLoggedOnUsers=1)

    status = update('get_status')

    assert status['automatic_updates'] == {
        'AUOptions': 4, 'NoAutoUpdate': 0, 'NoAutoRebootWithLoggedOnUsers': 1,
        'AlwaysAutoRebootAtScheduledTime': None, 'ScheduledInstallDay': 3,
        'ScheduledInstallTime': 3, 'ScheduledInstallEveryWeek': 1,
    }
    assert (status['scheduled_install_day'], status['scheduled_install_time']) == (3, 3)
    assert any('NoAutoRebootWithLoggedOnUsers' in w and 'policy active hours' in w
               for w in status['warnings'])


def test_status_lists_every_deadline_and_which_still_forces_a_restart(registry, update):
    registry.set(P, SetComplianceDeadlineForQU=1, ConfigureDeadlineForQualityUpdates=3,
                 ConfigureDeadlineNoAutoRebootForQualityUpdates=1,
                 AutoRestartDeadlinePeriodInDays=7)
    registry.set(AU, AutoRestartDeadlinePeriodInDays=7)
    # policymanager keeps its bookkeeping beside each value it sets
    registry.set(MDM, ConfigureDeadlineForFeatureUpdates=14,
                 ConfigureDeadlineForFeatureUpdates_ProviderSet=1)

    status = update('get_status')

    assert {(d['where'], d['name']): d['forces_restart'] for d in status['restart_deadlines']} == {
        ('policy', 'SetComplianceDeadlineForQU'): True,
        ('policy', 'ConfigureDeadlineForQualityUpdates'): True,
        ('policy', 'ConfigureDeadlineNoAutoRebootForQualityUpdates'): False,
        # the windows 10 deadline counts only once SetAutoRestartDeadline turns it on
        ('policy', 'AutoRestartDeadlinePeriodInDays'): False,
        ('policy_au', 'AutoRestartDeadlinePeriodInDays'): False,
        ('mdm', 'ConfigureDeadlineForFeatureUpdates'): True,
    }
    assert status['auto_restart_deadline_days'] == 7
    assert any('deadline' in w and 'inside active hours' in w for w in status['warnings'])


def test_status_reports_pause_mdm_conflict_and_pending_restarts(registry, ran, update):
    registry.set(UPS, PausedQualityStatus=1, PausedFeatureStatus=0,
                 PausedQualityDate='2026-10-20T10:00:00Z')
    registry.set(MDM_CONFLICT, MDMWinsOverGP=1)
    registry.set(SESSION_MANAGER, PendingFileRenameOperations=['\\??\\C:\\x', ''])
    ran.reply('Microsoft.Update.SystemInfo', (0, 'False\r\n', ''))

    status = update('get_status')

    assert status['pause']['PausedQualityStatus'] == 1
    assert status['pause']['PausedFeatureStatus'] == 0
    assert status['mdm_conflict'] == {'MDMWinsOverGP': 1, 'IgnoreWindowsUpdateGroupPolicies': None}
    assert any('mdm' in w for w in status['warnings'])
    # file renames are not a windows update restart
    assert status['update_restart_pending'] == {
        'pending': False, 'reboot_required_key': False, 'wua_reboot_required': False,
    }
    assert status['file_renames_pending'] is True


@pytest.mark.parametrize('key, wua, pending', [
    (True, 'False', True),
    (False, 'True', True),
    (False, None, False),
])
def test_status_reads_a_pending_update_restart_from_the_key_and_wua(
        registry, ran, update, key, wua, pending):
    if key:
        registry.set(REBOOT_REQUIRED)
    if wua is not None:
        ran.reply('Microsoft.Update.SystemInfo', (0, wua, ''))

    result = update('get_status')['update_restart_pending']

    assert result['pending'] is pending
    assert result['wua_reboot_required'] == {'True': True, 'False': False, None: None}[wua]


def test_status_writes_nothing(registry, update):
    registry.set(UX, ActiveHoursStart=8, ActiveHoursEnd=2)

    update('get_status')

    assert registry.ops == []


# ─── set_active_hours ───────────────────────────────────────────────────────


def test_set_active_hours_writes_the_policy_window_switch_last(registry, update):
    result = update('set_active_hours', start_hour=7, end_hour=23)

    assert registry.writes() == [
        ('ActiveHoursStart', 7, 4), ('ActiveHoursEnd', 23, 4), ('SetActiveHours', 1, 4),
    ]
    assert registry.writes(P) == registry.writes()
    assert result['status'] == 'ok'
    assert result['active_hours'] == {'start': 7, 'end': 23, 'source': 'policy'}
    assert any('settings' in note for note in result['notes'])


def test_set_active_hours_no_longer_writes_the_user_setting(registry, update):
    update('set_active_hours', start_hour=7, end_hour=23)

    assert registry.writes(UX) == []
    assert 'IsActiveHoursEnabled' not in registry.values(UX)


@pytest.mark.parametrize('start, end, message', [
    (None, 17, 'integers'),
    ('nine', 17, 'integers'),
    (24, 5, '0-23'),
    (-1, 5, '0-23'),
    (9, 9, 'differ'),
    (6, 1, 'at most 18 hours'),
    (20, 15, 'at most 18 hours'),
])
def test_set_active_hours_validates_before_writing(registry, update, start, end, message):
    result = update('set_active_hours', start_hour=start, end_hour=end)

    assert message in result['error']
    assert registry.ops == []


def test_a_wrapping_window_of_eighteen_hours_is_allowed(update):
    """Measured: Settings accepts 8 to 2 across midnight, the full 18 hours."""
    assert update('set_active_hours', start_hour=21, end_hour=15)['status'] == 'ok'


@pytest.mark.parametrize('keys, longest', [
    ({P: {'SetActiveHoursMaxRange': 1, 'ActiveHoursMaxRange': 12}}, 12),
    ({MDM: {'ActiveHoursMaxRange': 10}}, 10),
    # a maximum the policy does not switch on is not in force
    ({P: {'ActiveHoursMaxRange': 12}}, 18),
], ids=['policy', 'mdm', 'policy-off'])
def test_the_longest_window_comes_from_policy_then_mdm(registry, update, keys, longest):
    for path, values in keys.items():
        registry.set(path, **values)

    # from 8, so both windows keep 14:00 inside them
    too_long = update('set_active_hours', start_hour=8, end_hour=(8 + longest + 1) % 24)
    fits = update('set_active_hours', start_hour=8, end_hour=(8 + longest) % 24)

    assert f'at most {longest} hours' in too_long['error']
    assert fits['status'] == 'ok'


@pytest.mark.parametrize('mdm', [
    {'ActiveHoursStart': 8, 'ActiveHoursEnd': 17}, {'ActiveHoursEnd': 17},
])
def test_set_active_hours_refuses_a_window_mdm_manages(registry, update, mdm):
    registry.set(MDM, **mdm)

    result = update('set_active_hours', start_hour=7, end_hour=23)

    assert 'managed by MDM' in result['error']
    assert registry.ops == []


def test_set_active_hours_will_not_move_now_out_of_the_window(registry, update):
    """At 14:00 inside the default 8-17, a window of 18-23 would leave the
    machine outside its active hours: an unattended caller could shrink the
    window and then reboot."""
    result = update('set_active_hours', start_hour=18, end_hour=23)

    assert result == {'error': (
        'active_hours: inside active hours 08:00–17:00 (machine time); they end at '
        '17:00 — changing the window now needs an override'
    )}
    assert registry.ops == []


def test_an_approved_override_moves_now_out_of_the_window(registry, update):
    result = update('set_active_hours', override=OVERRIDE, start_hour=18, end_hour=23)

    assert result['active_hours'] == {'start': 18, 'end': 23, 'source': 'policy'}
    assert registry.values(P)['SetActiveHours'] == 1
    # what the service logs to the site: the override, and the window it moved now out of
    assert result['override_used'] is True
    assert result['previous_active_hours'] == {'start': 8, 'end': 17, 'source': 'default'}


def test_an_override_the_new_window_did_not_need_is_not_reported(update):
    result = update('set_active_hours', override=OVERRIDE, start_hour=7, end_hour=23)

    assert result['status'] == 'ok'
    assert 'override_used' not in result
    assert 'previous_active_hours' not in result


@pytest.mark.parametrize('override', [
    'yes',
    {},
    {'reason': 'closing early'},
    {'reason': 'closing early', 'approvedBy': ''},
    {'reason': '   ', 'approvedBy': 'user:u1'},
    {'reason': 'x' * 501, 'approvedBy': 'user:u1'},
    {'reason': 'closing early', 'approvedBy': 7},
], ids=['string', 'empty', 'no-approver', 'blank-approver', 'blank-reason',
        'long-reason', 'approver-not-a-string'])
def test_an_override_without_a_reason_and_an_approver_is_refused(registry, update, override):
    result = update('set_active_hours', override=override, start_hour=18, end_hour=23)

    assert result['error'].startswith('active_hours: ')
    assert registry.ops == []


@pytest.mark.parametrize('now, start, end', [
    # outside the window: nothing to move out of
    (datetime(2026, 10, 21, 20, 0), 9, 17),
    # inside, and still inside the new window
    (NOW, 7, 23),
    (NOW, 14, 15),
])
def test_a_window_that_keeps_now_where_it_is_needs_no_override(
        registry, clock, update, now, start, end):
    clock(now)

    assert update('set_active_hours', start_hour=start, end_hour=end)['status'] == 'ok'


# ─── limit_auto_restart ─────────────────────────────────────────────────────


DEADLINES = {
    'SetAutoRestartDeadline': 1, 'AutoRestartDeadlinePeriodInDays': 7,
    'AutoRestartDeadlinePeriodInDaysForFeatureUpdates': 14,
    'SetComplianceDeadline': 1, 'SetComplianceDeadlineForQU': 1,
    'SetComplianceDeadlineForFU': 1, 'ConfigureDeadlineForQualityUpdates': 2,
    'ConfigureDeadlineForFeatureUpdates': 7, 'ConfigureDeadlineGracePeriod': 1,
    'ConfigureDeadlineGracePeriodForFeatureUpdates': 2,
    'ConfigureDeadlineNoAutoReboot': 0,
    'ConfigureDeadlineNoAutoRebootForQualityUpdates': 0,
}


def test_limit_auto_restart_sets_the_window_and_removes_every_local_deadline(registry, update):
    registry.set(P, DeferQualityUpdates=1, **DEADLINES)
    registry.set(AU, AutoRestartDeadlinePeriodInDays=7, AUOptions=4)

    result = update('limit_auto_restart', start_hour=7, end_hour=23)

    assert registry.values(P) == {
        'DeferQualityUpdates': 1,
        'ActiveHoursStart': 7, 'ActiveHoursEnd': 23, 'SetActiveHours': 1,
    }
    assert registry.values(AU) == {'AUOptions': 4}
    assert sorted(registry.deletes(P)) == sorted(DEADLINES)
    assert registry.deletes(AU) == ['AutoRestartDeadlinePeriodInDays']
    assert result['status'] == 'ok'
    assert result['active_hours'] == {'start': 7, 'end': 23, 'source': 'policy'}
    assert 'WindowsUpdate\\AU\\AutoRestartDeadlinePeriodInDays' in result['removed_deadlines']
    assert result['remaining_deadlines'] == []
    assert any('outside active hours (07:00–23:00' in note for note in result['notes'])


def test_limit_auto_restart_writes_the_window_before_the_switch(registry, update):
    update('limit_auto_restart', start_hour=7, end_hour=23)

    names = [name for name, _, _ in registry.writes(P)]
    assert names == ['ActiveHoursStart', 'ActiveHoursEnd', 'SetActiveHours']


def test_limit_auto_restart_keeps_the_current_window_by_default(registry, update):
    registry.set(UX, ActiveHoursStart=8, ActiveHoursEnd=2)

    result = update('limit_auto_restart')

    assert result['active_hours'] == {'start': 8, 'end': 2, 'source': 'policy'}
    assert registry.values(UX) == {'ActiveHoursStart': 8, 'ActiveHoursEnd': 2}


def test_limit_auto_restart_reports_a_deadline_it_cannot_remove(registry, update):
    registry.set(MDM, ConfigureDeadlineForQualityUpdates=3)

    result = update('limit_auto_restart')

    assert [(d['where'], d['name'], d['forces_restart'])
            for d in result['remaining_deadlines']] == [
        ('mdm', 'ConfigureDeadlineForQualityUpdates', True),
    ]
    assert any('deadline' in w for w in result['warnings'])
    assert registry.values(MDM) == {'ConfigureDeadlineForQualityUpdates': 3}


def test_limit_auto_restart_needs_both_hours_or_neither(registry, update):
    result = update('limit_auto_restart', start_hour=7)

    assert 'start_hour and end_hour' in result['error']
    assert registry.ops == []


def test_limit_auto_restart_is_held_to_the_same_window_rules(registry, update):
    registry.set(P, ConfigureDeadlineForQualityUpdates=2)

    refused = update('limit_auto_restart', start_hour=18, end_hour=23)
    registry.set(MDM, ActiveHoursStart=8, ActiveHoursEnd=17)
    managed = update('limit_auto_restart')

    assert refused['error'].startswith('active_hours: inside active hours 08:00–17:00')
    assert 'managed by MDM' in managed['error']
    assert registry.ops == []


def test_limit_auto_restart_reports_the_override_it_used(update):
    result = update('limit_auto_restart', override=OVERRIDE, start_hour=18, end_hour=23)

    assert result['status'] == 'ok'
    assert result['override_used'] is True
    assert result['previous_active_hours'] == {'start': 8, 'end': 17, 'source': 'default'}


# ─── disable_auto_install / enable_auto_install ─────────────────────────────


def test_disable_auto_install_downloads_and_waits_for_a_person(registry, update):
    registry.set(AU, AUOptions=4, NoAutoUpdate=0, ScheduledInstallDay=3,
                 ScheduledInstallTime=3, ScheduledInstallEveryWeek=1,
                 NoAutoRebootWithLoggedOnUsers=1)

    result = update('disable_auto_install')

    assert registry.values(AU) == {
        'AUOptions': 3, 'NoAutoUpdate': 0, 'NoAutoRebootWithLoggedOnUsers': 1,
    }
    assert sorted(registry.deletes(AU)) == [
        'ScheduledInstallDay', 'ScheduledInstallEveryWeek', 'ScheduledInstallTime',
    ]
    assert result['status'] == 'ok'
    assert result['automatic_updates'] == {'AUOptions': 3, 'NoAutoUpdate': 0}
    assert 'security updates' in result['note'] and 'wait' in result['note']


def test_disable_auto_install_on_a_machine_with_no_policy_yet(registry, update):
    update('disable_auto_install')

    assert registry.values(AU) == {'NoAutoUpdate': 0, 'AUOptions': 3}


def test_enable_auto_install_hands_installs_back_to_windows(registry, update):
    registry.set(AU, AUOptions=3, NoAutoUpdate=1, ScheduledInstallDay=0,
                 ScheduledInstallTime=3, NoAutoRebootWithLoggedOnUsers=1)

    result = update('enable_auto_install')

    assert registry.values(AU) == {'NoAutoRebootWithLoggedOnUsers': 1}
    assert result['status'] == 'ok'
    assert sorted(result['removed']) == [
        'AUOptions', 'NoAutoUpdate', 'ScheduledInstallDay', 'ScheduledInstallTime',
    ]


# ─── pause / resume ─────────────────────────────────────────────────────────


def test_pause_writes_all_six_values_and_waits_for_windows_to_confirm(registry, update):
    result = update('pause', pause_days=7)

    start = NOW.astimezone(timezone.utc)
    begins = start.strftime('%Y-%m-%dT%H:%M:%SZ')
    ends = (start + timedelta(days=7)).strftime('%Y-%m-%dT%H:%M:%SZ')
    assert {name: (value, kind) for name, value, kind in registry.writes(UX)} == {
        'PauseUpdatesStartTime': (begins, 1), 'PauseUpdatesExpiryTime': (ends, 1),
        'PauseFeatureUpdatesStartTime': (begins, 1), 'PauseFeatureUpdatesEndTime': (ends, 1),
        'PauseQualityUpdatesStartTime': (begins, 1), 'PauseQualityUpdatesEndTime': (ends, 1),
    }
    assert all(re.fullmatch(r'\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ', v) for v in (begins, ends))
    assert result['status'] == 'written_not_confirmed'
    assert result['note'].startswith('written, not yet confirmed by windows')
    assert result['pause_until'] == ends


def test_pause_is_reported_paused_only_once_windows_says_so(registry, update):
    registry.set(UPS, PausedQualityStatus=1, PausedFeatureStatus=1)

    assert update('pause', pause_days=7)['status'] == 'paused'


def test_pause_of_one_kind_alone_is_not_confirmed(registry, update):
    registry.set(UPS, PausedQualityStatus=1, PausedFeatureStatus=0)

    assert update('pause', pause_days=7)['status'] == 'written_not_confirmed'


@pytest.mark.parametrize('policy, said', [
    ({'SetDisablePauseUXAccess': 1}, 'SetDisablePauseUXAccess'),
    ({'PauseQualityUpdatesStartTime': '2026-10-20'}, 'PauseQualityUpdatesStartTime'),
    ({'PauseFeatureUpdates': 1}, 'PauseFeatureUpdates'),
], ids=['pause-turned-off', 'policy-pause', 'policy-pause-1607'])
def test_pause_reports_a_policy_that_decides_instead_of_writing(registry, update, policy, said):
    registry.set(P, **policy)

    result = update('pause', pause_days=7)

    assert result['status'] == 'not_written'
    assert said in result['reason']
    assert registry.ops == []


@pytest.mark.parametrize('days', [0, 36, 'week'])
def test_pause_days_are_validated(registry, update, days):
    assert 'pause_days' in update('pause', pause_days=days)['error']
    assert registry.ops == []


def test_resume_removes_all_six_values(registry, update):
    registry.set(UX, ActiveHoursStart=8, ActiveHoursEnd=2,
                 **{name: '2026-10-28T03:00:00Z' for name in UX_PAUSE_VALUES})

    result = update('resume')

    assert sorted(registry.deletes(UX)) == sorted(UX_PAUSE_VALUES)
    assert registry.values(UX) == {'ActiveHoursStart': 8, 'ActiveHoursEnd': 2}
    assert result['status'] == 'resumed'


def test_resume_says_so_while_windows_still_reports_paused(registry, update):
    registry.set(UX, PauseUpdatesExpiryTime='2026-10-28T03:00:00Z')
    registry.set(UPS, PausedQualityStatus=1, PausedFeatureStatus=1)

    result = update('resume')

    assert result['status'] == 'cleared_not_confirmed'


# ─── deferrals and the removed deadline action ──────────────────────────────


@pytest.mark.parametrize('action, days, switch, period', [
    ('set_feature_deferral', 30, 'DeferFeatureUpdates', 'DeferFeatureUpdatesPeriodInDays'),
    ('set_quality_deferral', 7, 'DeferQualityUpdates', 'DeferQualityUpdatesPeriodInDays'),
])
def test_deferrals_are_written_where_windows_reads_them(registry, update, action, days,
                                                       switch, period):
    result = update(action, days=days)

    assert result['status'] == 'ok'
    assert registry.values(P) == {switch: 1, period: days}
    assert registry.writes(AU) == []


def test_set_restart_deadline_is_gone(registry, update):
    """It wrote under AU, where Windows never reads it, and could only ever
    force a restart."""
    result = update('set_restart_deadline', deadline_days=7)

    assert 'Unknown action' in result['error']
    assert registry.ops == []


# ─── registry_operation leaves active hours to this tool ────────────────────


@pytest.fixture
def registry_op(tools_windows):
    def call(action, key_path, value_name='', **params):
        return tools_windows.registry_operation(
            {'action': action, 'hive': 'HKLM', 'key_path': key_path,
             'value_name': value_name, **params}, None)
    return call


# every value osadapter.active_hours() reads the window from, the maximum
# set_active_hours checks against, and the two that let windows rewrite or
# drop the user's window
ACTIVE_HOURS_VALUES = [
    (P, 'ActiveHoursStart'), (P, 'ActiveHoursEnd'), (P, 'SetActiveHours'),
    (P, 'ActiveHoursMaxRange'), (P, 'SetActiveHoursMaxRange'),
    (UX, 'ActiveHoursStart'), (UX, 'ActiveHoursEnd'),
    (UX, 'SmartActiveHoursState'), (UX, 'IsActiveHoursEnabled'),
]


@pytest.mark.parametrize('action', ['write', 'delete'])
@pytest.mark.parametrize('key, name', ACTIVE_HOURS_VALUES)
def test_registry_operation_will_not_change_active_hours(registry, registry_op, key, name, action):
    """A raw write would move the window around the check set_active_hours
    makes, and a reboot inside the old window would then pass the guard with
    nobody approving it."""
    registry.set(key, **{name: 8})

    result = registry_op(action, key, name, value_type='dword', value_data='18')

    assert 'manage_windows_update set_active_hours or limit_auto_restart' in result['error']
    assert registry.ops == []
    assert registry.values(key) == {name: 8}


@pytest.mark.parametrize('key, name', [
    (P.lower(), 'activehoursstart'),
    (UX.upper(), 'ACTIVEHOURSEND'),
    (UX.replace('\\UX\\', '\\\\UX\\\\'), 'IsActiveHoursEnabled'),
    (P + '\\', 'SetActiveHours'),
    ('\\' + P, 'ActiveHoursMaxRange'),
], ids=['lower', 'upper', 'doubled-backslash', 'trailing-backslash', 'leading-backslash'])
def test_registry_operation_knows_active_hours_however_the_path_is_spelled(
        registry, registry_op, key, name):
    """Measured on Windows 11: the registry ignores case in key and value
    names, and a doubled or trailing backslash opens the same key."""
    result = registry_op('write', key, name, value_type='dword', value_data='0')

    assert 'manage_windows_update' in result['error']
    assert registry.ops == []


def test_registry_operation_still_reads_active_hours(registry, registry_op):
    registry.set(P, SetActiveHours=1, ActiveHoursStart=6, ActiveHoursEnd=22)

    assert registry_op('read', P, 'ActiveHoursStart')['value'] == 6
    assert [value['name'] for value in registry_op('read', P)['values']] == [
        'SetActiveHours', 'ActiveHoursStart', 'ActiveHoursEnd',
    ]


def test_registry_operation_still_writes_the_other_update_values(registry, registry_op):
    result = registry_op('write', P, 'DeferQualityUpdates', value_type='dword', value_data='1')

    assert result['status'] == 'ok'
    assert registry.writes(P) == [('DeferQualityUpdates', 1, 4)]


def test_registry_operation_cannot_delete_the_key_that_holds_them(registry, registry_op):
    registry.set(P, SetActiveHours=1, ActiveHoursStart=6, ActiveHoursEnd=22)

    result = registry_op('delete', P)

    assert 'key deletion not supported' in result['error']
    assert registry.ops == []


@pytest.mark.parametrize('key, name', [
    (MDM, 'ActiveHoursStart'), (MDM, 'ActiveHoursMaxRange'),
    (MDM, 'IgnoreWindowsUpdateGroupPolicies'), (MDM_CONFLICT, 'MDMWinsOverGP'),
])
def test_registry_operation_cannot_reach_the_mdm_window(registry, registry_op, key, name):
    """MDM's window and the switches that put it over group policy stay
    outside the allowlist; allowing them would need the same refusal."""
    result = registry_op('write', key, name, value_type='dword', value_data='1')

    assert 'not in the allowlist' in result['error']
    assert registry.ops == []


# ─── execute_tool forwards the override to this tool only ───────────────────


def test_execute_tool_forwards_the_override_to_manage_windows_update(registry):
    refused = mcp_tools.execute_tool(
        'manage_windows_update', {'action': 'set_active_hours', 'start_hour': 18, 'end_hour': 23})
    allowed = mcp_tools.execute_tool(
        'manage_windows_update', {'action': 'set_active_hours', 'start_hour': 18, 'end_hour': 23},
        None, command_id='c1', active_hours_override=OVERRIDE)

    assert refused['error'].startswith('active_hours: ')
    assert allowed['status'] == 'ok'


def test_execute_tool_keeps_the_override_from_every_other_tool(tools_windows, monkeypatch):
    seen = []
    monkeypatch.setitem(tools_windows.HANDLERS, 'configure_gpu_tdr',
                        lambda params, config: seen.append(params) or {'status': 'ok'})

    result = mcp_tools.execute_tool('configure_gpu_tdr', {'timeout_seconds': 8}, None,
                                    active_hours_override=OVERRIDE)

    assert result == {'status': 'ok'}
    assert seen == [{'timeout_seconds': 8}]


# ─── check_pending_reboot ───────────────────────────────────────────────────


@pytest.fixture
def build(tools_windows, monkeypatch):
    def on(number):
        monkeypatch.setattr(tools_windows, '_windows_build', lambda: number)
    on(22631)
    return on


def test_file_renames_alone_are_not_a_pending_restart(registry, build, tools_windows):
    """Measured on the dev box: PendingFileRenameOperations set, nothing from
    Windows Update waiting."""
    registry.set(SESSION_MANAGER, PendingFileRenameOperations=['\\??\\C:\\x', ''])

    result = tools_windows.check_pending_reboot({}, None)

    assert result['pending'] is False
    assert result['reasons'] == []
    assert result['file_renames'] is True


def test_an_update_restart_is_pending_beside_file_renames(registry, build, tools_windows):
    registry.set(REBOOT_REQUIRED)
    registry.set(CBS_REBOOT)
    registry.set(SESSION_MANAGER, PendingFileRenameOperations=['\\??\\C:\\x', ''])

    result = tools_windows.check_pending_reboot({}, None)

    assert result['pending'] is True
    assert result['reasons'] == ['windows_update', 'cbs']
    assert result['file_renames'] is True


def test_windows_11_has_no_reboot_task_to_read(registry, build, ran, tools_windows):
    result = tools_windows.check_pending_reboot({}, None)

    assert [call for call in ran.calls if call[0] == 'schtasks.exe'] == []
    assert result['next_scheduled_update'] == {
        'task': None, 'next_run': None, 'note': 'unknown on this build',
    }
    assert set(result) == {
        'pending', 'reasons', 'file_renames', 'last_update_installed', 'next_scheduled_update',
    }


def test_windows_10_still_reads_the_reboot_task(build, ran, tools_windows):
    build(19045)
    ran.reply('schtasks.exe', (0, 'TaskName: \\Reboot\r\nNext Run Time: 10/22/2026 3:00:00 AM\r\n', ''))

    result = tools_windows.check_pending_reboot({}, None)

    assert result['next_scheduled_update'] == {
        'task': r'\Microsoft\Windows\UpdateOrchestrator\Reboot',
        'next_run': '10/22/2026 3:00:00 AM',
    }
