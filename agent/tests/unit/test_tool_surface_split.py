"""The split hoot tool surface: mcp_tools + tools_windows + tools_posix.

From 3.4.0 the agent runs on three operating systems. The seventeen
Windows-shaped handlers moved out of `mcp_tools` into `tools_windows`; seven
tools gained macOS and Linux backends (six in `tools_posix`, plus `run_command`,
which stays in the core because it is cancellable and reaches this platform
through its allow-list); every other Windows-only tool refuses structurally
rather than dying on a missing executable.

`sys.platform` is monkeypatched rather than skipped, so the POSIX arms are
exercised from the Windows dev box and from all three CI legs, and
`mcp_tools.run_capture` is stubbed in every test that would shell out — no test
here runs a real system command.
"""

import os
import sys
import tempfile
from types import SimpleNamespace

import pytest

import mcp_tools
import osadapter
import tools_posix


# The tools whose only implementation is Windows: the eleven relocated ones,
# which the POSIX table simply does not carry, plus the two PowerShell shells
# that stayed in the core and are dispatched on every platform.
SHELLS = ('run_powershell', 'execute_script')
DISPATCH_GATED = sorted(mcp_tools.WINDOWS_ONLY_TOOLS - set(SHELLS))

# The six relocated tools with a POSIX backend. run_command is the seventh and
# lives in mcp_tools.
POSIX_BACKED = {
    'get_event_logs', 'get_service_status', 'check_pending_reboot',
    'show_notification', 'get_gpu_processes', 'manage_windows_service',
}

JOURNAL_LINES = (
    '{"__REALTIME_TIMESTAMP": "1757894400000000", "PRIORITY": "6", '
    '"SYSLOG_IDENTIFIER": "systemd", "MESSAGE": "Started owlette agent."}\n'
    '{"__REALTIME_TIMESTAMP": "1757894460000000", "PRIORITY": "3", '
    '"_COMM": "kernel", "MESSAGE": "gpu fault"}\n'
)

LOG_SHOW_JSON = (
    '[{"timestamp": "2026-09-15 09:12:31.123456-0700", "messageType": "error", '
    '"subsystem": "com.apple.windowserver", "eventMessage": "display lost"},'
    '{"timestamp": "2026-09-15 09:13:00.000000-0700", "messageType": "default", '
    '"processImagePath": "/usr/libexec/owlette-desktop", "eventMessage": "tray up"}]'
)


@pytest.fixture
def linux(monkeypatch):
    monkeypatch.setattr(sys, 'platform', 'linux')


@pytest.fixture
def macos(monkeypatch):
    monkeypatch.setattr(sys, 'platform', 'darwin')


@pytest.fixture
def ran(monkeypatch):
    """Record every argv handed to run_capture and answer from canned replies."""
    recorder = SimpleNamespace(calls=[], replies=[])

    def reply(match, result):
        recorder.replies.append((match, result))

    def run_capture(cmd, timeout=mcp_tools.SUBPROCESS_TIMEOUT, cwd=None):
        recorder.calls.append(list(cmd))
        joined = ' '.join(cmd)
        for match, result in recorder.replies:
            if match in joined:
                return result
        return 0, '', ''

    recorder.reply = reply
    monkeypatch.setattr(mcp_tools, 'run_capture', run_capture)
    return recorder


# ─── the gate ───────────────────────────────────────────────────────────────


@pytest.mark.parametrize('tool_name', DISPATCH_GATED)
def test_windows_only_tools_refuse_off_windows(tool_name, linux):
    result = mcp_tools.execute_tool(tool_name, {})

    assert result['error'] == 'unsupported_on_platform'
    assert result['tool'] == tool_name
    assert result['platform'] == 'linux'


@pytest.mark.parametrize('tool_name', SHELLS)
def test_the_shells_refuse_where_there_is_no_interpreter(tool_name, linux, monkeypatch):
    """The two cancellable shells are tagged Windows-only but dispatched
    everywhere; what turns them away off Windows is the missing interpreter, in
    the same shape as the gate's refusal."""
    def no_powershell(cmd, timeout, command_id, cwd=None):
        raise FileNotFoundError(cmd[0])

    monkeypatch.setattr(mcp_tools, '_run_tracked_subprocess', no_powershell)

    result = mcp_tools.execute_tool(tool_name, {'script': 'Get-Date'})

    assert result['error'] == 'unsupported_on_platform'
    assert result['tool'] == tool_name


def test_the_gate_names_every_tool_the_posix_arm_does_not_implement(linux):
    relocated = set(tools_posix.HANDLERS) | set(DISPATCH_GATED)

    assert set(tools_posix.HANDLERS) == POSIX_BACKED
    assert len(relocated) == 17
    assert not POSIX_BACKED & mcp_tools.WINDOWS_ONLY_TOOLS
    assert 'run_command' not in mcp_tools.WINDOWS_ONLY_TOOLS


@pytest.mark.skipif(sys.platform != 'win32', reason='the Windows arm imports winreg')
def test_the_windows_arm_implements_every_relocated_tool():
    import tools_windows

    assert set(tools_windows.HANDLERS) == set(tools_posix.HANDLERS) | set(DISPATCH_GATED)
    assert len(tools_windows.HANDLERS) == 17


@pytest.mark.skipif(sys.platform != 'win32', reason='the Windows arm imports winreg')
def test_a_gated_tool_still_runs_on_windows(monkeypatch):
    """Negative control for the gate: on Windows the same call reaches its
    handler instead of the refusal."""
    import tools_windows

    monkeypatch.setitem(
        tools_windows.HANDLERS, 'network_reset', lambda params, config: {'reached': True},
    )

    assert mcp_tools.execute_tool('network_reset', {}) == {'reached': True}


def test_an_unknown_tool_is_still_unknown_off_windows(linux):
    assert mcp_tools.execute_tool('teleport', {}) == {'error': 'Unknown tool: teleport'}


def test_cancellable_set_did_not_widen():
    """The POSIX backends run through the untracked wrapper: only the three
    shell tools register a PID for cancel_mcp_tool."""
    assert mcp_tools._CANCELLABLE_TOOLS == {
        'execute_script', 'run_powershell', 'run_command',
    }


# ─── the re-export shims ────────────────────────────────────────────────────


def test_check_pending_reboot_shim_reaches_the_posix_arm(linux, monkeypatch):
    """owlette_service and osadapter call mcp_tools.check_pending_reboot by
    name; the shim dispatches it to whichever arm this platform has."""
    monkeypatch.setattr(os.path, 'exists', lambda path: path in tools_posix._REBOOT_MARKERS)

    assert mcp_tools.check_pending_reboot({}, None) == {
        'pending': True,
        'reasons': ['package_update'],
        'last_update_installed': None,
        'next_scheduled_update': None,
    }


def test_show_notification_hands_the_message_to_the_desktop_app(linux, monkeypatch):
    """The pair is wired in opposite directions per platform: on Windows
    osadapter.notify() calls this tool, and here the tool calls osadapter,
    whose job seam is the only way a root daemon reaches a session.

    Set into the package's namespace rather than through setattr: the
    operations are served by a module __getattr__ that selects this machine's
    arm, and reading one here — on a Windows box calling itself linux — would
    import the POSIX arm's pwd and grp.
    """
    notified = []

    def notify(title, body):
        notified.append((title, body))
        return {'status': 'sent'}

    monkeypatch.setitem(osadapter.__dict__, 'notify', notify)

    result = mcp_tools.execute_tool(
        'show_notification', {'title': 'owlette', 'message': 'the projector is off'},
    )

    assert result == {'status': 'sent'}
    assert notified == [('owlette', 'the projector is off')]


def test_show_notification_needs_something_to_say(linux):
    result = mcp_tools.execute_tool('show_notification', {'title': 'owlette'})

    assert result['error'] == 'message is required'


# ─── file tools: the allowed bases ──────────────────────────────────────────


def test_file_tools_resolve_the_real_home_off_windows(linux, monkeypatch):
    # The override answers data_root() without an adapter, so this reads the
    # allow-list without an osadapter arm for the platform being faked.
    monkeypatch.setenv(
        'OWLETTE_DATA_ROOT', os.path.join(tempfile.gettempdir(), 'owlette-data-root'),
    )
    # Negative control: expandvars returns its argument untouched on POSIX, so
    # the old '%TEMP%' / '%USERPROFILE%' spelling put those literals in the
    # allow-list and locked every file tool out of the home directory.
    monkeypatch.setattr(os.path, 'expandvars', lambda value: value)

    bases = mcp_tools._get_allowed_file_bases({})

    assert all('%' not in base for base in bases)
    assert os.path.realpath(os.path.expanduser('~')) in bases
    assert os.path.realpath(tempfile.gettempdir()) in bases


def test_read_file_reaches_the_real_home_off_windows(tmp_path, monkeypatch, linux):
    """The task's done-when, on the tool that validates: list_directory never
    consulted the allow-list, so only the file tools can prove the home
    directory is reachable off Windows."""
    home = tmp_path / 'home'
    home.mkdir()
    (home / 'notes.txt').write_text('hello', encoding='utf-8')
    # A data root and a temp directory of their own, so the home base is the
    # only one this file can arrive through.
    monkeypatch.setenv('OWLETTE_DATA_ROOT', str(tmp_path / 'data'))
    monkeypatch.setattr(tempfile, 'gettempdir', lambda: str(tmp_path / 'tmp'))
    monkeypatch.setattr(
        os.path, 'expanduser', lambda path: str(home) if path == '~' else path,
    )
    # Negative control: with the old '%USERPROFILE%' spelling the base is that
    # literal off Windows, and the read is refused.
    monkeypatch.setattr(os.path, 'expandvars', lambda value: value)

    result = mcp_tools.execute_tool('read_file', {'path': str(home / 'notes.txt')})

    assert result['content'] == 'hello'


def test_file_paths_are_case_sensitive_off_windows(monkeypatch):
    """os.path.normcase folds case on Windows and is the identity everywhere
    else, so a path that differs from its base only in case is outside the
    allow-list on a case-sensitive filesystem — where the old .lower() accepted
    it, and write_file creates any missing parent of a path it accepts."""
    config = {'processes': [{'path': '/opt/roost/bin/player'}]}
    # Negative control: with Windows' own normcase both spellings resolve to the
    # same base, which is why this cannot be asserted on the real platform.
    monkeypatch.setattr(os.path, 'normcase', lambda path: path)

    assert mcp_tools._validate_file_path('/opt/roost/bin/notes.txt', config)[0]
    assert not mcp_tools._validate_file_path('/OPT/roost/bin/notes.txt', config)[0]


# ─── run_command: the per-platform allow-list ───────────────────────────────


@pytest.fixture
def tracked(monkeypatch):
    """Stub the cancellable subprocess path; record the argv it was handed."""
    seen = []

    def _run_tracked_subprocess(cmd, timeout, command_id, cwd=None):
        seen.append(list(cmd))
        return 0, 'ok', '', False

    monkeypatch.setattr(mcp_tools, '_run_tracked_subprocess', _run_tracked_subprocess)
    return seen


def test_the_shells_still_dispatch_off_windows(linux, tracked):
    """Gating the two shells at dispatch would strand test_mcp_cancel's mocked
    Popen on the macOS and Linux CI legs: the handler has to be reached."""
    result = mcp_tools.execute_tool(
        'run_powershell', {'script': 'Get-Date'}, None, command_id='ps-1',
    )

    assert result['exit_code'] == 0
    assert tracked == [['powershell', '-NoProfile', '-Command', 'Get-Date']]


def test_run_command_uses_the_posix_allow_list(linux, tracked):
    result = mcp_tools.execute_tool('run_command', {'command': "ls '/tmp/a b'"})

    assert result['exit_code'] == 0
    # posix=True quoting: the quoted path arrives as one argument, unquoted.
    assert tracked == [['ls', '/tmp/a b']]


def test_run_command_refuses_a_windows_only_command_off_windows(linux, tracked):
    result = mcp_tools.execute_tool('run_command', {'command': 'ipconfig /all'})

    assert 'not in the allow-list' in result['error']
    assert tracked == []


@pytest.mark.skipif(sys.platform != 'win32', reason='the Windows allow-list')
def test_run_command_keeps_windows_backslashes(tracked):
    mcp_tools.execute_tool('run_command', {'command': r'type C:\ProgramData\x.txt'})

    assert tracked == [['type', r'C:\ProgramData\x.txt']]


# ─── get_event_logs ─────────────────────────────────────────────────────────


def test_event_logs_read_the_journal_on_linux(linux, ran):
    ran.reply('journalctl', (0, JOURNAL_LINES, ''))

    result = mcp_tools.execute_tool('get_event_logs', {'max_events': 5})

    assert ran.calls == [[
        'journalctl', '--output=json', '--no-pager', '--lines=5',
    ]]
    assert result['source'] == 'journalctl'
    assert result['count'] == 2
    # Newest first, like the Windows arm's Get-EventLog -Newest.
    assert result['events'][0]['level'] == 'Error'
    assert result['events'][0]['source'] == 'kernel'
    assert result['events'][1]['message'] == 'Started owlette agent.'
    assert result['events'][0]['time_ago'].endswith('ago')


def test_event_logs_map_the_level_enum_to_an_exact_journald_priority(linux, ran):
    """A bare --priority=err is a ceiling — err and every severity above it. Each
    level maps to the range that carries its own name, so the filter answers in
    the level it was asked for, like the Windows arm's -EntryType."""
    ran.reply('journalctl', (0, '', ''))

    mcp_tools.execute_tool('get_event_logs', {'level': 'Error'})
    mcp_tools.execute_tool('get_event_logs', {'level': 'Warning'})
    mcp_tools.execute_tool('get_event_logs', {'level': 'Information'})

    assert [call[-1] for call in ran.calls] == [
        '--priority=err..err', '--priority=warning..warning', '--priority=notice..info',
    ]


def test_event_logs_reject_an_unknown_level_before_shelling_out(linux, ran):
    result = mcp_tools.execute_tool('get_event_logs', {'level': 'Sideways'})

    assert 'Invalid level' in result['error']
    assert ran.calls == []


def test_event_logs_read_log_show_on_macos(macos, ran):
    ran.reply('log show', (0, LOG_SHOW_JSON, ''))

    result = mcp_tools.execute_tool('get_event_logs', {})

    # The unified log takes a window, not a count: it is the only thing keeping
    # the query inside SUBPROCESS_TIMEOUT.
    assert ran.calls[0] == ['log', 'show', '--style', 'json', '--last', '10m']
    assert result['source'] == 'log show'
    assert result['events'][0]['source'] == 'owlette-desktop'
    # macOS message types, reported in the journal arm's vocabulary.
    assert result['events'][0]['level'] == 'Warning'
    assert result['events'][1]['level'] == 'Error'
    assert result['events'][1]['time'] == '2026-09-15 09:12:31'


def test_event_logs_scale_the_macos_window_to_max_events(macos, ran):
    """`log show` takes no count, so max_events can only bound the work through
    the window — the daemon decodes every record the query prints."""
    ran.reply('log show', (0, '[]', ''))

    mcp_tools.execute_tool('get_event_logs', {'max_events': 5})

    assert ran.calls[0][-2:] == ['--last', '2m']


@pytest.mark.skipif(sys.platform != 'win32', reason='the Windows arm')
def test_event_logs_report_the_level_names_on_windows(monkeypatch):
    """Both arms publish the vocabulary the level parameter takes: ConvertTo-Json
    serialises EntryType as the enum's integer, so without the mapping the same
    field is 4 on Windows and 'Information' on the other two platforms."""
    import tools_windows

    monkeypatch.setattr(
        tools_windows, '_run_powershell_script',
        lambda script, timeout=60, bypass=True: (0, (
            '[{"TimeGenerated": "/Date(1757894400000)/", "EntryType": 1, '
            '"Source": "Service Control Manager", "Message": "stopped"},'
            '{"TimeGenerated": "/Date(1757894460000)/", "EntryType": 4, '
            '"Source": "Owlette", "Message": "started"}]'
        ), ''),
    )

    result = mcp_tools.execute_tool('get_event_logs', {})

    assert [event['level'] for event in result['events']] == ['Error', 'Information']


def test_event_logs_ask_for_info_messages_on_macos(macos, ran):
    """`log show` leaves info-level messages out unless --info is passed, so the
    Information level would otherwise always come back empty."""
    ran.reply('log show', (0, '[]', ''))

    mcp_tools.execute_tool('get_event_logs', {'level': 'Information'})

    assert ran.calls[0][-3:] == ['--predicate', 'messageType == info', '--info']


def test_event_logs_report_a_failed_query_rather_than_raising(linux, ran):
    ran.reply('journalctl', (-1, '', 'journalctl timed out after 25s'))

    result = mcp_tools.execute_tool('get_event_logs', {})

    assert 'Failed to query journalctl' in result['error']


# ─── get_service_status ─────────────────────────────────────────────────────


def test_service_status_reads_systemctl_show(linux, ran):
    ran.reply('systemctl show', (0, (
        'ActiveState=active\nSubState=running\n'
        'UnitFileState=enabled\nLoadState=loaded\n'
    ), ''))

    result = mcp_tools.execute_tool('get_service_status', {'service_name': 'owlette-agent'})

    assert result == {
        'service_name': 'owlette-agent',
        'status': 'running',
        'start_type': 'automatic',
        'sub_state': 'running',
    }


def test_service_status_reports_an_unknown_unit(linux, ran):
    ran.reply('systemctl show', (0, 'ActiveState=inactive\nLoadState=not-found\n', ''))

    result = mcp_tools.execute_tool('get_service_status', {'service_name': 'nope'})

    assert result == {'error': 'Service not found: nope'}


def test_service_status_reads_launchctl_list(macos, ran):
    ran.reply('launchctl list', (0, (
        '{\n\t"LimitLoadToSessionType" = "System";\n\t"OnDemand" = false;\n'
        '\t"LastExitStatus" = 0;\n\t"PID" = 412;\n\t"Label" = "app.owlette.agent";\n};\n'
    ), ''))

    result = mcp_tools.execute_tool('get_service_status', {'service_name': 'app.owlette.agent'})

    assert result == {
        'service_name': 'app.owlette.agent',
        'status': 'running',
        'start_type': 'automatic',
        'pid': 412,
    }


def test_service_status_validates_the_name_before_shelling_out(linux, ran):
    result = mcp_tools.execute_tool('get_service_status', {'service_name': 'a; rm -rf /'})

    assert 'Invalid service_name' in result['error']
    assert ran.calls == []


# ─── manage_windows_service: the wire name keeps its POSIX arms ─────────────


def test_manage_service_starts_a_systemd_unit(linux, ran):
    result = mcp_tools.execute_tool(
        'manage_windows_service', {'action': 'start', 'service_name': 'owlette-agent'},
    )

    assert ran.calls == [['systemctl', 'start', 'owlette-agent']]
    assert result == {'action': 'start', 'service': 'owlette-agent', 'status': 'ok'}


def test_manage_service_restarts_a_launchd_job(macos, ran):
    mcp_tools.execute_tool(
        'manage_windows_service', {'action': 'restart', 'service_name': 'app.owlette.agent'},
    )

    assert ran.calls == [
        ['launchctl', 'kickstart', '-k', 'system/app.owlette.agent'],
    ]


def test_manage_service_stops_a_launchd_job_with_bootout(macos, ran):
    """`launchctl kill SIGTERM` only signals the job, and launchd relaunches
    anything with KeepAlive — which the owlette daemon's plist carries — so the
    tool would report a stop that had not happened."""
    result = mcp_tools.execute_tool(
        'manage_windows_service', {'action': 'stop', 'service_name': 'app.owlette.agent'},
    )

    assert ran.calls == [['launchctl', 'bootout', 'system/app.owlette.agent']]
    assert result == {'action': 'stop', 'service': 'app.owlette.agent', 'status': 'ok'}


def test_manage_service_masks_a_disabled_unit(linux, ran):
    mcp_tools.execute_tool('manage_windows_service', {
        'action': 'set_startup', 'service_name': 'owlette-agent', 'startup_type': 'disabled',
    })

    assert ran.calls == [['systemctl', 'mask', 'owlette-agent']]


def test_manage_service_unmasks_before_it_enables(linux, ran):
    """systemctl enable and disable both fail on a masked unit, so without the
    unmask a `set_startup disabled` could not be lifted through this tool."""
    mcp_tools.execute_tool('manage_windows_service', {
        'action': 'set_startup', 'service_name': 'owlette-agent', 'startup_type': 'auto',
    })

    assert ran.calls == [
        ['systemctl', 'unmask', 'owlette-agent'],
        ['systemctl', 'enable', 'owlette-agent'],
    ]


def test_manage_service_bootstraps_a_launchd_job_it_booted_out(macos, monkeypatch):
    """kickstart reaches only a job that is still bootstrapped, and `stop` boots
    the job out of the domain — so a stop through this tool has to be a stop this
    tool can undo."""
    plist = '/Library/LaunchDaemons/app.owlette.agent.plist'
    monkeypatch.setattr(os.path, 'exists', lambda path: path == plist)
    calls = []

    def run_capture(cmd, timeout=mcp_tools.SUBPROCESS_TIMEOUT, cwd=None):
        calls.append(list(cmd))
        if cmd[1] == 'kickstart' and ['launchctl', 'bootstrap', 'system', plist] not in calls:
            return 1, '', 'Could not find service "app.owlette.agent" in domain for system'
        return 0, '', ''

    monkeypatch.setattr(mcp_tools, 'run_capture', run_capture)

    result = mcp_tools.execute_tool(
        'manage_windows_service', {'action': 'start', 'service_name': 'app.owlette.agent'},
    )

    assert calls == [
        ['launchctl', 'kickstart', 'system/app.owlette.agent'],
        ['launchctl', 'bootstrap', 'system', plist],
        ['launchctl', 'kickstart', 'system/app.owlette.agent'],
    ]
    assert result == {'action': 'start', 'service': 'app.owlette.agent', 'status': 'ok'}


def test_manage_service_reports_the_start_failure_when_there_is_no_plist(macos, ran, monkeypatch):
    monkeypatch.setattr(os.path, 'exists', lambda path: False)
    ran.reply('kickstart', (1, '', 'Could not find service in domain for system'))

    result = mcp_tools.execute_tool(
        'manage_windows_service', {'action': 'start', 'service_name': 'app.owlette.agent'},
    )

    assert [call[1] for call in ran.calls] == ['kickstart']
    assert result['error'].startswith('start failed:')


def test_manage_service_refuses_an_action_the_init_system_lacks(linux, ran):
    result = mcp_tools.execute_tool(
        'manage_windows_service', {'action': 'pause', 'service_name': 'owlette-agent'},
    )

    assert 'is not supported on linux' in result['error']
    assert 'set_startup' in result['error']
    assert ran.calls == []


def test_manage_service_reports_a_failed_control(linux, ran):
    ran.reply('systemctl stop', (1, '', 'Failed to stop owlette-agent.service: Access denied'))

    result = mcp_tools.execute_tool(
        'manage_windows_service', {'action': 'stop', 'service_name': 'owlette-agent'},
    )

    assert result['error'].startswith('stop failed:')


def test_manage_service_details_carry_the_windows_keys(linux, ran):
    ran.reply('systemctl show', (0, (
        'Description=owlette agent\nActiveState=active\nUnitFileState=enabled\n'
        'MainPID=990\nExecStart={ path=/opt/owlette/python ; }\nUser=root\n'
        'Requires=sysinit.target\nRestart=always\n'
    ), ''))

    result = mcp_tools.execute_tool(
        'manage_windows_service', {'action': 'get_details', 'service_name': 'owlette-agent'},
    )

    assert result['service'] == 'owlette-agent'
    assert result['status'] == 'running'
    assert result['process_id'] == 990
    assert result['start_type'] == 'automatic'
    assert result['recovery_raw'] == 'always'


# ─── check_pending_reboot ───────────────────────────────────────────────────


def test_pending_reboot_reads_the_debian_marker(linux, monkeypatch):
    monkeypatch.setattr(os.path, 'exists', lambda path: False)

    result = mcp_tools.execute_tool('check_pending_reboot', {})

    assert result['pending'] is False
    assert result['reasons'] == []
    # The same four keys the Windows arm returns: osadapter.pending_reboot() is
    # one shape on all three platforms.
    assert set(result) == {
        'pending', 'reasons', 'last_update_installed', 'next_scheduled_update',
    }


def test_pending_reboot_reads_softwareupdate_on_macos(macos, ran):
    ran.reply('softwareupdate', (0, (
        '* Label: macOS Sequoia 15.6.1-24G90\n'
        '\tTitle: macOS Sequoia, Version: 15.6.1, Size: 3.2 GiB, Recommended: YES, '
        'Action: restart, [restart]\n'
    ), ''))

    result = mcp_tools.execute_tool('check_pending_reboot', {})

    assert ran.calls == [['softwareupdate', '--list', '--no-scan']]
    assert result['pending'] is True
    assert result['reasons'] == ['software_update']


def test_pending_reboot_reports_a_failed_softwareupdate_query(macos, ran):
    ran.reply('softwareupdate', (-1, '', 'softwareupdate timed out after 25s'))

    assert 'softwareupdate query failed' in mcp_tools.execute_tool('check_pending_reboot', {})['error']


# ─── get_gpu_processes ──────────────────────────────────────────────────────


def test_gpu_processes_read_nvidia_smi(linux, ran, monkeypatch):
    monkeypatch.setattr(mcp_tools, 'gpu_totals', lambda: {'gpus': [], 'source': 'unavailable'})
    monkeypatch.setattr(
        tools_posix.psutil, 'Process', lambda pid: SimpleNamespace(name=lambda: f'proc-{pid}'),
    )
    ran.reply('nvidia-smi', (0, '1200, 512\n1300, 2048\n', ''))

    result = mcp_tools.execute_tool('get_gpu_processes', {})

    assert ran.calls[0][0] == 'nvidia-smi'
    assert result['process_count'] == 2
    assert result['processes'][0] == {
        'pid': 1300, 'name': 'proc-1300', 'dedicated_gpu_mb': 2048.0, 'shared_gpu_mb': 0,
    }


def test_gpu_processes_explain_a_machine_without_nvidia_smi(linux, ran, monkeypatch):
    monkeypatch.setattr(mcp_tools, 'gpu_totals', lambda: {'gpus': [], 'source': 'unavailable'})
    ran.reply('nvidia-smi', (-1, '', 'No such file or directory'))

    result = mcp_tools.execute_tool('get_gpu_processes', {})

    assert result['processes'] == []
    assert 'nvidia-smi' in result['note']
    assert 'error' not in result


# ─── the shared subprocess helper ───────────────────────────────────────────


def test_run_capture_turns_a_missing_binary_into_a_return_code(monkeypatch):
    def explode(*args, **kwargs):
        raise FileNotFoundError('nvidia-smi')

    monkeypatch.setattr(mcp_tools.subprocess, 'Popen', explode)

    assert mcp_tools.run_capture(['nvidia-smi'], 5) == (-1, '', 'nvidia-smi')


def test_run_capture_reports_a_timeout_as_a_return_code(monkeypatch):
    monkeypatch.setattr(
        mcp_tools, '_run', lambda *args, **kwargs: (None, 'partial', '', True),
    )

    assert mcp_tools.run_capture(['journalctl'], 25) == (
        -1, 'partial', 'journalctl timed out after 25s',
    )


# ─── the never-kill set ─────────────────────────────────────────────────────


@pytest.mark.parametrize('name,critical', [
    # the daemon and the desktop app under their POSIX names — the windows
    # image names protect neither, and manage_process is cross-platform.
    ('python3', True),
    ('python', True),
    ('owlette-desktop', True),
    ('owlette-host', True),
    # pid 1 and the session/security daemons.
    ('systemd', True),
    ('systemd-logind', True),
    ('dbus-daemon', True),
    ('sshd', True),
    ('init', True),
    ('launchd', True),
    ('loginwindow', True),
    ('WindowServer', True),
    ('SystemUIServer', True),
    # what an operator is entitled to kill.
    ('TouchDesigner', False),
    ('resolve', False),
    ('chrome', False),
    # windows image names carry no meaning off windows.
    ('csrss.exe', False),
])
def test_the_posix_never_kill_set(name, critical, linux):
    assert mcp_tools._is_critical_process(name) is critical


@pytest.mark.parametrize('name,critical', [
    ('csrss.exe', True),
    ('owlette_service.exe', True),
    ('python.exe', True),
    ('TouchDesigner.exe', False),
    # and the POSIX names mean nothing here.
    ('loginwindow', False),
    ('python3', False),
])
def test_the_windows_never_kill_set_is_unchanged(name, critical, monkeypatch):
    monkeypatch.setattr(sys, 'platform', 'win32')
    assert mcp_tools._is_critical_process(name) is critical


def test_an_empty_process_name_is_refused_on_every_platform(macos):
    assert mcp_tools._is_critical_process('') is True
    assert mcp_tools._is_critical_process(None) is True
