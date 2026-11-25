"""What the hoot tools do with their parameters, on the real handlers.

The windows half runs real PowerShell. Every command that would change the machine
is stubbed out as a function in the script's own scope, so a run reads and builds
as it would in the field and changes nothing; a value that reaches the script as
code writes a marker file in the test's temp folder, and nothing else.
"""

import base64
import json
import os
import sys
import xml.etree.ElementTree as ET
from types import SimpleNamespace

import pytest

import mcp_tools

windows_only = pytest.mark.skipif(sys.platform != 'win32', reason='runs real PowerShell')

RQ = '\u201d'
LQ = '\u201c'

# the commands in a tool's script that change the machine. an alias outranks every
# other command type; a function would not do, because ScheduledTasks' commands are
# functions and loading the module replaces one of the same name.
STUBS = 'function owlette_noop { }; ' + ''.join(
    f'Set-Alias {name} owlette_noop; ' for name in (
        'Enable-WindowsOptionalFeature', 'Disable-WindowsOptionalFeature',
        'Get-WindowsOptionalFeature', 'Get-WindowsCapability',
        'Add-WindowsCapability', 'Remove-WindowsCapability',
        'Remove-AppxPackage', 'Get-AppxProvisionedPackage', 'Remove-AppxProvisionedPackage',
    )
) + (
    'function owlette_task { param($TaskName, $Trigger, $Action, $Principal, '
    '$Settings, $Description, [switch]$Force) '
    '$j = @{name=$TaskName; exe=$Action.Execute; args=$Action.Arguments; '
    'wd=$Action.WorkingDirectory; desc=$Description} | ConvertTo-Json -Compress; '
    "[Console]::Out.WriteLine('OWLETTE_TASK:' + "
    '[Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($j))) }; '
    'Set-Alias Register-ScheduledTask owlette_task; '
)

SHOW_TOAST = '[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier("Owlette").Show($toast); '
PRINT_TOAST = (
    "[Console]::Out.WriteLine('OWLETTE_TOAST:' + "
    '[Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($doc.GetXml()))); '
)


def _printed(runs, prefix):
    for _, out, _ in runs:
        for line in out.splitlines():
            if line.startswith(prefix):
                return base64.b64decode(line[len(prefix):]).decode('utf-8')
    return None


@pytest.fixture
def powershell(monkeypatch):
    """mcp_tools.run_capture on real PowerShell, with the machine-changing commands stubbed."""
    real = mcp_tools.run_capture
    runs = []

    def run_capture(cmd, timeout=mcp_tools.SUBPROCESS_TIMEOUT, cwd=None):
        if cmd[0] == 'powershell':
            script = STUBS + cmd[-1].replace(SHOW_TOAST, PRINT_TOAST)
            cmd = [*cmd[:-1], script]
        result = real(cmd, timeout, cwd)
        runs.append(result)
        return result

    monkeypatch.setattr(mcp_tools, 'run_capture', run_capture)
    return SimpleNamespace(runs=runs)


@pytest.fixture
def captured(monkeypatch):
    """Every argv a handler would run, with nothing run."""
    calls = []

    def run_capture(cmd, timeout=mcp_tools.SUBPROCESS_TIMEOUT, cwd=None):
        calls.append(list(cmd))
        return 0, '[]', ''

    monkeypatch.setattr(mcp_tools, 'run_capture', run_capture)
    return calls


def _task(**over):
    return {
        'action': 'create',
        'task_name': 'owlette test task',
        'trigger': {'type': 'boot'},
        'task_action': {'type': 'run_program', 'program': 'notepad.exe'},
        **over,
    }


def _trigger(**fields):
    return _task(trigger=fields)


def _program(**fields):
    return _task(task_action={'type': 'run_program', 'program': 'notepad.exe', **fields})


BREAK_DOUBLE = 'x' + RQ + '; {p}; #'
BREAK_SINGLE = "x'; {p}; #"

# tool, parameters with {p} where the marker command goes
HOSTILE = {
    'event_logs.log_name': ('get_event_logs', {'log_name': 'Application -Newest 1; {p}; #'}),
    'event_logs.level': ('get_event_logs', {'log_name': 'Application', 'level': 'Error; {p}; #'}),
    'filtered.process_name': ('get_event_logs_filtered', {'log_name': 'Application', 'process_name': "x'+({p})+'"}),
    'feature.appx_list': ('manage_windows_feature', {
        'type': 'appx_package', 'action': 'list',
        'name_filter': 'x' + RQ + '}; {p}; Get-Date | Where-Object {' + LQ + 'y',
    }),
    'feature.optional_list': ('manage_windows_feature', {
        'type': 'optional_feature', 'action': 'list',
        'name_filter': 'x' + RQ + '}; {p}; Get-Date | Where-Object {' + LQ + 'y',
    }),
    'feature.capability_list': ('manage_windows_feature', {
        'type': 'capability', 'action': 'list',
        'name_filter': 'x' + RQ + '}; {p}; Get-Date | Where-Object {' + LQ + 'y',
    }),
    'feature.optional_install': ('manage_windows_feature', {'type': 'optional_feature', 'action': 'install', 'name': BREAK_DOUBLE}),
    'feature.optional_remove': ('manage_windows_feature', {'type': 'optional_feature', 'action': 'remove', 'name': BREAK_DOUBLE}),
    'feature.capability_install': ('manage_windows_feature', {'type': 'capability', 'action': 'install', 'name': BREAK_DOUBLE}),
    'feature.capability_remove': ('manage_windows_feature', {'type': 'capability', 'action': 'remove', 'name': BREAK_DOUBLE}),
    'feature.appx_remove': ('manage_windows_feature', {'type': 'appx_package', 'action': 'remove', 'name': BREAK_DOUBLE}),
    'feature.appx_remove_all': ('manage_windows_feature', {'type': 'appx_package', 'action': 'remove', 'name': BREAK_DOUBLE, 'all_users': True}),
    'task.user': ('manage_scheduled_task', _trigger(type='logon', user=BREAK_DOUBLE)),
    'task.once_at': ('manage_scheduled_task', _trigger(type='once', start_datetime=BREAK_DOUBLE)),
    'task.daily_at': ('manage_scheduled_task', _trigger(type='daily', start_time=BREAK_DOUBLE)),
    'task.weekly_at': ('manage_scheduled_task', _trigger(type='weekly', start_time=BREAK_DOUBLE, days_of_week=['mon'])),
    'task.event_log': ('manage_scheduled_task', _trigger(type='on_event', event_id=1, log_name=BREAK_SINGLE)),
    'task.event_source': ('manage_scheduled_task', _trigger(type='on_event', event_id=1, source='; {p}; #')),
    'task.event_source_expression': ('manage_scheduled_task', _trigger(type='on_event', event_id=1, source='+({p})+')),
    'task.program': ('manage_scheduled_task', _program(program=BREAK_DOUBLE)),
    'task.arguments': ('manage_scheduled_task', _program(arguments=BREAK_DOUBLE)),
    'task.working_directory': ('manage_scheduled_task', _program(working_directory=BREAK_DOUBLE)),
    'task.description': ('manage_scheduled_task', _task(description=BREAK_DOUBLE)),
    'toast.title': ('show_notification', {'title': "x'; {p}; $y='", 'message': 'm'}),
    'toast.message': ('show_notification', {'title': 't', 'message': "x'; {p}; $y='"}),
    'toast.smart_quote': ('show_notification', {'title': 'x\u2019; {p}; $y=\u2019', 'message': 'm'}),
}

# already refused by a pattern or a table: these stay that way.
GUARDED = {
    'task.history': ('manage_scheduled_task', {'action': 'get_history', 'task_name': BREAK_DOUBLE}),
    'task.details': ('manage_scheduled_task', {'action': 'get_details', 'task_name': BREAK_DOUBLE}),
    'task.create_name': ('manage_scheduled_task', _task(task_name=BREAK_DOUBLE)),
    'filtered.log_name': ('get_event_logs_filtered', {'log_name': "Application'; {p}; #"}),
    'event_logs.max_events': ('get_event_logs', {'max_events': '1; {p}; #'}),
    'filtered.hours_back': ('get_event_logs_filtered', {'log_name': 'Application', 'hours_back': '1; {p}; #'}),
    'filtered.event_id': ('get_event_logs_filtered', {'log_name': 'Application', 'event_id': '1; {p}; #'}),
    'task.weekly_days': ('manage_scheduled_task', _trigger(type='weekly', days_of_week=['mon; {p}; #'])),
    'task.principal': ('manage_scheduled_task', _task(principal={'run_as': 'SYSTEM"; {p}; #'})),
    'task.interval': ('manage_scheduled_task', _trigger(type='daily', days_interval='1; {p}; #')),
}


def _fill(value, command):
    if isinstance(value, str):
        return value.replace('{p}', command)
    if isinstance(value, list):
        return [_fill(item, command) for item in value]
    if isinstance(value, dict):
        return {key: _fill(item, command) for key, item in value.items()}
    return value


def _run_hostile(case, tmp_path):
    tool, params = case
    marker = tmp_path / 'marker.txt'
    command = f"Set-Content -LiteralPath '{marker.as_posix()}' -Value x"
    result = mcp_tools.execute_tool(tool, _fill(params, command), {})
    return marker, result


@windows_only
@pytest.mark.parametrize('case', HOSTILE.values(), ids=HOSTILE.keys())
def test_a_hostile_value_never_runs(case, tmp_path, powershell):
    marker, result = _run_hostile(case, tmp_path)
    assert not marker.exists(), f'ran as code: {result}'


@windows_only
@pytest.mark.parametrize('case', GUARDED.values(), ids=GUARDED.keys())
def test_a_hostile_value_stays_refused(case, tmp_path, powershell):
    marker, result = _run_hostile(case, tmp_path)
    assert not marker.exists(), f'ran as code: {result}'
    assert 'error' in result


@windows_only
@pytest.mark.parametrize('quote', ["'", '\u2018', '\u2019', '\u201a', '\u201b', '"', LQ, RQ, '\u201e', '`', '$'])
def test_a_literal_holds_every_quote_form_and_escape(quote, powershell):
    from tools_windows import _ps_literal, _run_powershell_script

    text = f'a{quote}b{quote}{quote}c$(Get-Date)'
    codes = ','.join(str(ord(c)) for c in text)
    script = (
        f'$want = -join ([char[]]@({codes})); '
        f"if ({_ps_literal(text)} -ceq $want) {{ 'same' }} else {{ 'different' }}"
    )
    rc, out, err = _run_powershell_script(script, bypass=False)
    assert rc == 0, err
    assert out.strip() == 'same'


@windows_only
def test_local_hoot_reaches_the_same_refusal(tmp_path, powershell):
    pytest.importorskip('claude_agent_sdk')
    import cortex_tools

    marker = tmp_path / 'marker.txt'
    command = f"Set-Content -LiteralPath '{marker.as_posix()}' -Value x"
    result = cortex_tools._execute_direct_sync('get_event_logs', {'log_name': f'Application; {command}; #'}, {})
    assert not marker.exists()
    assert 'Invalid log_name' in result['content'][0]['text']


@windows_only
@pytest.mark.parametrize('log_name', ['Application', 'System', 'application', 'SYSTEM'])
def test_real_event_logs_answer(log_name, powershell):
    result = mcp_tools.execute_tool('get_event_logs', {'log_name': log_name, 'max_events': 1}, {})
    assert 'error' not in result, result
    assert result['log_name'].lower() == log_name.lower()


@windows_only
@pytest.mark.parametrize('level', ['Error', 'Warning', 'Information', 'error', 'FailureAudit', 'SuccessAudit'])
def test_every_event_level_reaches_the_query(level, captured):
    result = mcp_tools.execute_tool('get_event_logs', {'log_name': 'Application', 'level': level}, {})
    assert 'error' not in result, result
    assert f'-EntryType {level[0].upper()}' in captured[0][-1]


@windows_only
def test_the_security_log_is_still_asked_for(captured):
    result = mcp_tools.execute_tool('get_event_logs', {'log_name': 'Security', 'max_events': 2}, {})
    assert 'error' not in result, result
    assert '-LogName Security -Newest 4' in captured[0][-1]


@windows_only
@pytest.mark.parametrize('log_name', ['Windows PowerShell', 'Application -ComputerName other', 'Applicatio', ''])
def test_any_other_log_name_is_refused(log_name, captured):
    result = mcp_tools.execute_tool('get_event_logs', {'log_name': log_name}, {})
    assert 'Invalid log_name' in result['error']
    assert captured == []


@windows_only
@pytest.mark.parametrize('max_events', [0, -1, 'many', None])
def test_a_max_events_that_is_no_count_is_refused(max_events, captured):
    result = mcp_tools.execute_tool('get_event_logs', {'max_events': max_events}, {})
    assert 'max_events' in result['error']
    assert captured == []


@windows_only
def test_a_real_provider_with_spaces_answers(powershell):
    result = mcp_tools.execute_tool('get_event_logs_filtered', {
        'log_name': 'System', 'process_name': 'Service Control Manager', 'hours_back': 168, 'max_events': 1,
    }, {})
    assert 'error' not in result, result


@windows_only
@pytest.mark.parametrize('process_name', [
    'Application Error', 'Microsoft-Windows-Kernel-Power', '.NET Runtime',
    'Service Control Manager', 'Windows Error Reporting', 'McAfee (R) Agent', 'TCP/IP',
])
def test_real_providers_reach_the_query(process_name, captured):
    result = mcp_tools.execute_tool('get_event_logs_filtered', {'log_name': 'Application', 'process_name': process_name}, {})
    assert 'error' not in result, result
    assert f"ProviderName='{process_name}'" in captured[0][-1]


@windows_only
@pytest.mark.parametrize('ftype,action,name', [
    ('optional_feature', 'install', 'NetFx3'),
    ('optional_feature', 'remove', 'Microsoft-Hyper-V-All'),
    ('optional_feature', 'remove', 'OpenSSH-Server'),
    ('capability', 'install', 'OpenSSH.Client~~~~0.0.1.0'),
    ('capability', 'remove', 'Language.Basic~~~af-ZA~0.0.1.0'),
    ('appx_package', 'remove', 'Microsoft.XboxGameBar'),
    ('appx_package', 'remove', 'Microsoft.549981C3F5F10'),
])
def test_real_feature_names_reach_the_query(ftype, action, name, captured):
    result = mcp_tools.execute_tool('manage_windows_feature', {'type': ftype, 'action': action, 'name': name}, {})
    assert 'error' not in result, result
    assert name in captured[0][-1]


@windows_only
def test_a_real_appx_filter_lists(powershell):
    result = mcp_tools.execute_tool('manage_windows_feature', {
        'type': 'appx_package', 'action': 'list', 'name_filter': 'Microsoft.Windows',
    }, {})
    assert 'error' not in result, result


@windows_only
def test_a_feature_filter_keeps_spaces_and_wildcards(captured):
    result = mcp_tools.execute_tool('manage_windows_feature', {
        'type': 'optional_feature', 'action': 'list', 'name_filter': 'Open SSH*',
    }, {})
    assert 'error' not in result, result
    assert '*Open SSH**' in captured[0][-1]


@windows_only
@pytest.mark.parametrize('name', ['Microsoft.W*', '*', 'Micro?oft.WindowsStore'])
def test_a_wildcard_cannot_widen_a_removal(name, captured):
    result = mcp_tools.execute_tool('manage_windows_feature', {'type': 'appx_package', 'action': 'remove', 'name': name}, {})
    assert 'Invalid name' in result['error']
    assert captured == []


@windows_only
def test_a_toast_carries_quotes_and_markup_as_text(powershell):
    title = "don't \"stop\" <now> & $(Get-Date) `x"
    message = 'caf\u00e9 \u2018smart\u2019 \u201cdouble\u201d \U0001f989'
    result = mcp_tools.execute_tool('show_notification', {'title': title, 'message': message}, {})
    assert result.get('status') == 'sent', result
    texts = [e.text for e in ET.fromstring(_printed(powershell.runs, 'OWLETTE_TOAST:')).iter('text')]
    assert texts == [title, message]


@windows_only
def test_a_modal_message_stays_one_argument(monkeypatch):
    spawned = []
    monkeypatch.setattr(mcp_tools.subprocess, 'Popen', lambda cmd, **kw: spawned.append(cmd))
    result = mcp_tools.execute_tool('show_notification', {'message': "don't; touch", 'style': 'modal'}, {})
    assert result == {'style': 'modal', 'status': 'sent'}
    assert spawned == [['msg.exe', '*', '/TIME:5', "don't; touch"]]


@windows_only
def test_a_task_keeps_paths_arguments_and_description_as_written(powershell):
    fields = {
        'program': r'C:\Program Files\Derivative\TouchDesigner.exe',
        'arguments': r"""-File "C:\x y\z.ps1" -Name 'a' $env:X `n""",
        'working_directory': r"C:\it's here",
    }
    description = 'it\'s "a" $(task)'
    result = mcp_tools.execute_tool('manage_scheduled_task', _task(
        task_action={'type': 'run_program', **fields}, description=description,
    ), {})
    assert result.get('status') == 'ok', result
    task = json.loads(_printed(powershell.runs, 'OWLETTE_TASK:'))
    assert task == {
        'name': 'owlette test task',
        'exe': fields['program'],
        'args': fields['arguments'],
        'wd': fields['working_directory'],
        'desc': description,
    }


@windows_only
@pytest.mark.parametrize('trigger', [
    {'type': 'boot'},
    {'type': 'logon'},
    {'type': 'logon', 'user': r'ACME\kiosk user'},
    {'type': 'once', 'start_datetime': '2030-01-31T14:00:00'},
    {'type': 'once', 'start_datetime': '1/31/2030 2:00 PM'},
    {'type': 'daily', 'start_time': '04:00', 'days_interval': 2},
    {'type': 'daily', 'start_time': '3am'},
    {'type': 'weekly', 'start_time': '04:00', 'days_of_week': ['mon', 'sun']},
    {'type': 'on_event', 'event_id': 1000},
    {'type': 'on_event', 'event_id': 41, 'log_name': 'System', 'source': 'Microsoft-Windows-Kernel-Power'},
    {'type': 'on_event', 'event_id': 101, 'log_name': 'Microsoft-Windows-TaskScheduler/Operational'},
    {'type': 'on_idle', 'idle_minutes': 5},
])
def test_every_trigger_type_still_builds(trigger, powershell):
    result = mcp_tools.execute_tool('manage_scheduled_task', _task(trigger=trigger), {})
    assert result.get('status') == 'ok', result
    assert _printed(powershell.runs, 'OWLETTE_TASK:') is not None


@windows_only
@pytest.mark.parametrize('trigger,field', [
    ({'type': 'logon', 'user': 'a;b'}, 'user'),
    ({'type': 'once', 'start_datetime': '2030-01-01;x'}, 'start_datetime'),
    ({'type': 'daily', 'start_time': '04:00;x'}, 'start_time'),
    ({'type': 'on_event', 'event_id': 1, 'log_name': 'a;b'}, 'log_name'),
    ({'type': 'on_event', 'event_id': 1, 'source': "a'b"}, 'source'),
])
def test_a_trigger_field_out_of_its_pattern_is_refused(trigger, field, captured):
    result = mcp_tools.execute_tool('manage_scheduled_task', _task(trigger=trigger), {})
    assert field in result['error']
    assert captured == []


@windows_only
def test_a_path_outside_the_allowed_folders_is_refused():
    inside = mcp_tools.shared_utils.get_data_path()
    climbed = os.path.join(inside, *['..'] * 40, 'Windows', 'win.ini')
    for path in (r'C:\Windows\win.ini', climbed):
        assert 'outside allowed' in mcp_tools.execute_tool('read_file', {'path': path}, {})['error']


# the posix arm runs argv only, so what a parameter can do there is be read as an option.


@pytest.fixture
def posix_run(monkeypatch):
    calls = []
    monkeypatch.setattr(sys, 'platform', 'linux')

    def run_capture(cmd, timeout=mcp_tools.SUBPROCESS_TIMEOUT, cwd=None):
        calls.append(list(cmd))
        return 0, 'ActiveState=active\nLoadState=loaded\n', ''

    monkeypatch.setattr(mcp_tools, 'run_capture', run_capture)
    return calls


@pytest.mark.parametrize('tool,extra', [
    ('get_service_status', {}),
    ('manage_windows_service', {'action': 'restart'}),
])
@pytest.mark.parametrize('name', ['-Hroot@host.example', '--version', '-M.host'])
def test_a_service_name_cannot_be_read_as_an_option(tool, extra, name, posix_run):
    result = mcp_tools.execute_tool(tool, {'service_name': name, **extra}, {})
    assert 'Invalid service_name' in result['error']
    assert posix_run == []


def test_a_service_name_cannot_end_in_a_newline(posix_run):
    result = mcp_tools.execute_tool('get_service_status', {'service_name': 'ok\n'}, {})
    assert 'Invalid service_name' in result['error']
    assert posix_run == []


@pytest.mark.parametrize('name', ['ssh.service', 'getty@tty1.service', 'com.apple.Finder', 'dbus:1.service', 'owlette_agent'])
def test_real_service_names_are_asked_for(name, posix_run):
    result = mcp_tools.execute_tool('get_service_status', {'service_name': name}, {})
    assert 'error' not in result, result
    assert name in posix_run[0]
