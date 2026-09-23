"""Tests for MCP tool cancellation machinery (cortex async turns, wave 1).

Covers:
- execute_script timeout clamp to MAX_SCRIPT_TIMEOUT (3300s — under the
  1-hour pending-entry GC)
- the _RUNNING_COMMANDS registry lifecycle (registered during the run,
  removed on finish/timeout, skipped without a command_id)
- cancel_running_command killing the registered PID (and its idempotent
  no-op for unknown/finished commands)
- firebase_client._handle_cancel_mcp_tool writing the target's terminal
  'cancelled' entry and flagging it against result clobbering
- firebase_client._execute_command restart-safety 'running' marker and
  cancel_mcp_tool fast-lane dispatch
- firebase_client._seed_seen_commands marking interrupted 'running'
  entries as failed on service restart

firebase_client is imported lazily inside the helpers/tests (matching
test_cancel_sync_fastlane.py) to avoid eagerly initializing the cryptography
rust bindings at collection time (PyO3 single-init ordering issue).
"""

import json
import subprocess
from types import SimpleNamespace
from unittest.mock import MagicMock

import pytest


@pytest.fixture(autouse=True)
def _clean_running_registry():
    """Keep the module-level running-command registry isolated per test."""
    import mcp_tools
    with mcp_tools._RUNNING_COMMANDS_LOCK:
        mcp_tools._RUNNING_COMMANDS.clear()
    yield
    with mcp_tools._RUNNING_COMMANDS_LOCK:
        mcp_tools._RUNNING_COMMANDS.clear()


def _mock_popen(monkeypatch, pid=4242, returncode=0, communicate_side_effect=None):
    """Patch subprocess.Popen with a mock process and return (proc, popen)."""
    import mcp_tools
    proc = MagicMock()
    proc.pid = pid
    proc.returncode = returncode
    if communicate_side_effect is not None:
        proc.communicate.side_effect = communicate_side_effect
    else:
        proc.communicate.return_value = ('out', '')
    popen = MagicMock(return_value=proc)
    monkeypatch.setattr(mcp_tools.subprocess, 'Popen', popen)
    return proc, popen


# ─── execute_script: timeout clamp ──────────────────────────────────────────


def test_timeout_clamped_to_max(monkeypatch):
    import mcp_tools
    proc, _ = _mock_popen(monkeypatch)

    result = mcp_tools._execute_script(
        {'script': 'Get-Date', 'timeout_seconds': 999999}, None
    )

    proc.communicate.assert_called_once_with(timeout=mcp_tools.MAX_SCRIPT_TIMEOUT)
    assert mcp_tools.MAX_SCRIPT_TIMEOUT == 3300
    assert result['timed_out'] is False


def test_timeout_under_cap_passes_through(monkeypatch):
    import mcp_tools
    proc, _ = _mock_popen(monkeypatch)

    mcp_tools._execute_script({'script': 'Get-Date', 'timeout_seconds': 120}, None)

    proc.communicate.assert_called_once_with(timeout=120)


# ─── execute_script: running-command registry ───────────────────────────────


def test_registry_holds_pid_during_run_and_clears_after(monkeypatch):
    import mcp_tools
    seen_during_run = {}

    def communicate(timeout=None):
        seen_during_run.update(mcp_tools._RUNNING_COMMANDS)
        return ('out', '')

    _mock_popen(monkeypatch, pid=4242, communicate_side_effect=communicate)

    result = mcp_tools.execute_tool(
        'execute_script', {'script': 'Get-Date'}, None, command_id='cmd-1'
    )

    assert seen_during_run == {'cmd-1': 4242}
    assert 'cmd-1' not in mcp_tools._RUNNING_COMMANDS
    assert result['exit_code'] == 0


def test_registry_cleared_on_timeout(monkeypatch):
    import mcp_tools
    kill = MagicMock()
    monkeypatch.setattr(mcp_tools, '_kill_process_tree', kill)
    _mock_popen(
        monkeypatch,
        pid=4242,
        communicate_side_effect=[
            subprocess.TimeoutExpired(cmd='powershell', timeout=1),
            ('', ''),  # drain after the tree kill
        ],
    )

    result = mcp_tools._execute_script(
        {'script': 'Start-Sleep 999', 'timeout_seconds': 1}, None, command_id='cmd-2'
    )

    assert result['timed_out'] is True
    kill.assert_called_once_with(4242)
    assert 'cmd-2' not in mcp_tools._RUNNING_COMMANDS


def test_no_registration_without_command_id(monkeypatch):
    import mcp_tools

    def communicate(timeout=None):
        assert mcp_tools._RUNNING_COMMANDS == {}
        return ('out', '')

    _mock_popen(monkeypatch, communicate_side_effect=communicate)

    mcp_tools._execute_script({'script': 'Get-Date'}, None)

    assert mcp_tools._RUNNING_COMMANDS == {}


def test_execute_tool_threads_command_id_to_shell_tools(monkeypatch):
    """command_id is threaded to every shell-spawning tool (execute_script,
    run_powershell, run_command) so each can register its subprocess for
    cancellation — but NOT to read-only handlers, which keep the 2-arg
    signature."""
    import mcp_tools
    calls = {}

    def make_shell_fake(key):
        def fake(params, config, command_id=None):
            calls[key] = command_id
            return {}
        return fake

    def fake_info(params, config):
        calls['info'] = True
        return {}

    monkeypatch.setattr(mcp_tools, '_execute_script', make_shell_fake('execute_script'))
    monkeypatch.setattr(mcp_tools, '_run_powershell', make_shell_fake('run_powershell'))
    monkeypatch.setattr(mcp_tools, '_run_command', make_shell_fake('run_command'))
    monkeypatch.setattr(mcp_tools, '_get_system_info', fake_info)

    mcp_tools.execute_tool('execute_script', {}, None, command_id='cmd-9')
    mcp_tools.execute_tool('run_powershell', {}, None, command_id='cmd-9')
    mcp_tools.execute_tool('run_command', {}, None, command_id='cmd-9')
    mcp_tools.execute_tool('get_system_info', {}, None, command_id='cmd-9')

    assert calls == {
        'execute_script': 'cmd-9',
        'run_powershell': 'cmd-9',
        'run_command': 'cmd-9',
        'info': True,
    }


def test_run_powershell_registers_pid_for_cancellation(monkeypatch):
    """run_powershell (the Cortex Tier-3 shell tool) must register its
    subprocess in _RUNNING_COMMANDS so the cancel button can kill it —
    regression guard for the cancel-is-a-no-op bug."""
    import mcp_tools
    seen_during_run = {}

    def communicate(timeout=None):
        seen_during_run.update(mcp_tools._RUNNING_COMMANDS)
        return ('out', '')

    _mock_popen(monkeypatch, pid=7777, communicate_side_effect=communicate)

    result = mcp_tools.execute_tool(
        'run_powershell', {'script': 'Get-Date'}, None, command_id='ps-1'
    )

    assert seen_during_run == {'ps-1': 7777}
    assert 'ps-1' not in mcp_tools._RUNNING_COMMANDS
    assert result['exit_code'] == 0


def test_run_command_registers_pid_for_cancellation(monkeypatch):
    """run_command must likewise register its subprocess for cancellation."""
    import mcp_tools
    seen_during_run = {}

    def communicate(timeout=None):
        seen_during_run.update(mcp_tools._RUNNING_COMMANDS)
        return ('out', '')

    _mock_popen(monkeypatch, pid=8888, communicate_side_effect=communicate)

    result = mcp_tools.execute_tool(
        'run_command', {'command': 'hostname'}, None, command_id='rc-1'
    )

    assert seen_during_run == {'rc-1': 8888}
    assert 'rc-1' not in mcp_tools._RUNNING_COMMANDS
    assert result['exit_code'] == 0


# ─── cancel_running_command ─────────────────────────────────────────────────


def test_cancel_kills_registered_pid(monkeypatch):
    import mcp_tools
    kill = MagicMock()
    monkeypatch.setattr(mcp_tools, '_kill_process_tree', kill)
    with mcp_tools._RUNNING_COMMANDS_LOCK:
        mcp_tools._RUNNING_COMMANDS['cmd-3'] = 999

    assert mcp_tools.cancel_running_command('cmd-3') is True
    kill.assert_called_once_with(999)


def test_cancel_unknown_id_is_safe_noop(monkeypatch):
    import mcp_tools
    kill = MagicMock()
    monkeypatch.setattr(mcp_tools, '_kill_process_tree', kill)

    assert mcp_tools.cancel_running_command('nope') is False
    kill.assert_not_called()


# ─── firebase_client: _handle_cancel_mcp_tool ───────────────────────────────


def _make_cancel_client():
    from firebase_client import FirebaseClient
    svc = SimpleNamespace(
        logger=MagicMock(),
        connected=True,
        db=MagicMock(),
        site_id='site-1',
        machine_id='mach-1',
        _cancelled_commands=set(),
    )
    svc._handle_cancel_mcp_tool = FirebaseClient._handle_cancel_mcp_tool.__get__(svc, FirebaseClient)
    return svc


def _completed_ref(svc):
    """Walk the mocked collection/document chain to the completed doc ref."""
    return (
        svc.db.collection.return_value
        .document.return_value
        .collection.return_value
        .document.return_value
        .collection.return_value
        .document.return_value
    )


def test_handle_cancel_kills_and_writes_cancelled(monkeypatch):
    import mcp_tools
    kill = MagicMock()
    monkeypatch.setattr(mcp_tools, '_kill_process_tree', kill)
    with mcp_tools._RUNNING_COMMANDS_LOCK:
        mcp_tools._RUNNING_COMMANDS['tgt-1'] = 555
    svc = _make_cancel_client()

    # Production wire shape: executeMachineCommand spreads the payload at the
    # TOP LEVEL of the command doc (NOT nested under `params`).
    result = json.loads(svc._handle_cancel_mcp_tool(
        {'type': 'cancel_mcp_tool', 'target_command_id': 'tgt-1'}
    ))

    kill.assert_called_once_with(555)
    assert result == {'status': 'cancelled', 'target_command_id': 'tgt-1'}
    assert 'tgt-1' in svc._cancelled_commands

    set_call = _completed_ref(svc).set
    set_call.assert_called_once()
    payload = set_call.call_args[0][0]
    assert payload['tgt-1']['status'] == 'cancelled'
    assert payload['tgt-1']['error'] == 'cancelled by user'
    assert set_call.call_args[1] == {'merge': True}


def test_handle_cancel_flags_target_before_kill(monkeypatch):
    """The target must be added to _cancelled_commands BEFORE the process tree
    is killed: the killed script's own thread can unblock from communicate() and
    reach the _cancelled_commands guard the instant the kill lands, so the flag
    must already be set to win the race."""
    import mcp_tools
    svc = _make_cancel_client()
    membership_at_kill = {}

    def kill_spy(pid):
        membership_at_kill['flagged'] = 'tgt-1' in svc._cancelled_commands

    monkeypatch.setattr(mcp_tools, '_kill_process_tree', kill_spy)
    with mcp_tools._RUNNING_COMMANDS_LOCK:
        mcp_tools._RUNNING_COMMANDS['tgt-1'] = 555

    svc._handle_cancel_mcp_tool(
        {'type': 'cancel_mcp_tool', 'target_command_id': 'tgt-1'}
    )

    assert membership_at_kill == {'flagged': True}


def test_handle_cancel_reads_nested_params_fallback(monkeypatch):
    """Defensive fallback: a nested `params.target_command_id` is still honored
    if some caller ever sends the old shape."""
    import mcp_tools
    monkeypatch.setattr(mcp_tools, '_kill_process_tree', MagicMock())
    with mcp_tools._RUNNING_COMMANDS_LOCK:
        mcp_tools._RUNNING_COMMANDS['tgt-9'] = 777
    svc = _make_cancel_client()

    result = json.loads(svc._handle_cancel_mcp_tool(
        {'type': 'cancel_mcp_tool', 'params': {'target_command_id': 'tgt-9'}}
    ))

    assert result == {'status': 'cancelled', 'target_command_id': 'tgt-9'}


def test_handle_cancel_unknown_target_returns_safe_error():
    svc = _make_cancel_client()

    result = json.loads(svc._handle_cancel_mcp_tool(
        {'type': 'cancel_mcp_tool', 'target_command_id': 'gone'}
    ))

    assert result == {'error': 'command not running'}
    assert svc._cancelled_commands == set()
    _completed_ref(svc).set.assert_not_called()


def test_handle_cancel_missing_target_id_returns_safe_error():
    svc = _make_cancel_client()

    result = json.loads(svc._handle_cancel_mcp_tool({'type': 'cancel_mcp_tool'}))

    assert result == {'error': 'target_command_id is required'}
    _completed_ref(svc).set.assert_not_called()


# ─── firebase_client: _execute_command dispatch + restart safety ────────────


def _make_exec_client(monkeypatch, **overrides):
    import firebase_client
    from firebase_client import FirebaseClient
    monkeypatch.setattr(firebase_client.shared_utils, 'get_system_metrics', lambda: {})
    svc = SimpleNamespace(
        logger=MagicMock(),
        connected=True,
        db=MagicMock(),
        site_id='site-1',
        machine_id='mach-1',
        command_callback=MagicMock(return_value='ok'),
        _cancelled_commands=set(),
        _mark_command_running=MagicMock(),
        _mark_command_completed=MagicMock(),
        _mark_command_failed=MagicMock(),
        _mark_command_cancelled=MagicMock(),
        _handle_cancel_mcp_tool=MagicMock(return_value='{"status": "cancelled"}'),
        _upload_metrics=MagicMock(),
        log_event=MagicMock(),
    )
    for key, value in overrides.items():
        setattr(svc, key, value)
    # Both halves of the dispatch are real: _execute_command decides whether
    # the command is finished here at all, finish_command is what marks it.
    svc._execute_command = FirebaseClient._execute_command.__get__(svc, FirebaseClient)
    svc.finish_command = FirebaseClient.finish_command.__get__(svc, FirebaseClient)
    return svc


def test_cancel_mcp_tool_is_in_fast_set():
    from firebase_client import FirebaseClient
    assert 'cancel_mcp_tool' in FirebaseClient._FAST_COMMAND_TYPES


def test_running_marker_written_before_callback(monkeypatch):
    order = []
    svc = _make_exec_client(
        monkeypatch,
        _mark_command_running=MagicMock(side_effect=lambda *a: order.append('running')),
        command_callback=MagicMock(side_effect=lambda cmd_id, cmd_data: order.append('callback') or 'ok'),
    )

    svc._execute_command('cmd-1', {'type': 'mcp_tool_call'})

    assert order == ['running', 'callback']
    # No deployment context on a plain tool call — both threaded args are None.
    svc._mark_command_running.assert_called_once_with('cmd-1', None, 'mcp_tool_call')
    svc._mark_command_completed.assert_called_once_with('cmd-1', 'ok', None, 'mcp_tool_call')


def test_running_marker_carries_deployment_context(monkeypatch):
    """A deployment command threads deployment_id + type into the running
    marker so the restart-failover failed marker (and the deploymentStatus
    cloud function) can key off them — otherwise an interrupted deployment
    stays 'in_progress' forever."""
    svc = _make_exec_client(monkeypatch)

    svc._execute_command(
        'dep-cmd',
        {'type': 'install_software', 'deployment_id': 'dep-9'},
    )

    svc._mark_command_running.assert_called_once_with(
        'dep-cmd', 'dep-9', 'install_software'
    )


def test_mark_command_running_payload_includes_deployment_fields():
    """The running marker written to Firestore conditionally includes
    deployment_id/type (same pattern as the completed/failed markers)."""
    from firebase_client import FirebaseClient
    svc = SimpleNamespace(
        logger=MagicMock(),
        connected=True,
        db=MagicMock(),
        site_id='site-1',
        machine_id='mach-1',
    )
    svc._mark_command_running = FirebaseClient._mark_command_running.__get__(svc, FirebaseClient)

    svc._mark_command_running('dep-cmd', 'dep-9', 'install_software')

    set_call = _completed_ref(svc).set
    set_call.assert_called_once()
    payload = set_call.call_args[0][0]['dep-cmd']
    assert payload['status'] == 'running'
    assert payload['deployment_id'] == 'dep-9'
    assert payload['type'] == 'install_software'
    assert set_call.call_args[1] == {'merge': True}


def test_mark_command_running_omits_absent_deployment_fields():
    """No deployment context → the marker carries only status/startedAt (no
    None-valued deployment_id/type keys)."""
    from firebase_client import FirebaseClient
    svc = SimpleNamespace(
        logger=MagicMock(),
        connected=True,
        db=MagicMock(),
        site_id='site-1',
        machine_id='mach-1',
    )
    svc._mark_command_running = FirebaseClient._mark_command_running.__get__(svc, FirebaseClient)

    svc._mark_command_running('cmd-1')

    payload = _completed_ref(svc).set.call_args[0][0]['cmd-1']
    assert payload['status'] == 'running'
    assert 'deployment_id' not in payload
    assert 'type' not in payload


def test_cancel_mcp_tool_dispatches_handler_not_callback(monkeypatch):
    svc = _make_exec_client(monkeypatch)
    cmd = {'type': 'cancel_mcp_tool', 'target_command_id': 'tgt-1'}

    svc._execute_command('cmd-2', cmd)

    svc._handle_cancel_mcp_tool.assert_called_once_with(cmd)
    svc.command_callback.assert_not_called()
    svc._mark_command_completed.assert_called_once_with(
        'cmd-2', '{"status": "cancelled"}', None, 'cancel_mcp_tool'
    )


def test_cancelled_command_result_not_clobbered(monkeypatch):
    """A killed tool call's own thread must re-assert 'cancelled', not write
    the dead subprocess's result as 'completed'."""
    svc = _make_exec_client(monkeypatch, _cancelled_commands={'cmd-3'})

    svc._execute_command('cmd-3', {'type': 'mcp_tool_call'})

    svc._mark_command_cancelled.assert_called_once_with(
        'cmd-3', 'cancelled by user', None, 'mcp_tool_call'
    )
    svc._mark_command_completed.assert_not_called()
    assert svc._cancelled_commands == set()


def test_cancelled_command_exception_path_stays_cancelled(monkeypatch):
    svc = _make_exec_client(
        monkeypatch,
        _cancelled_commands={'cmd-4'},
        command_callback=MagicMock(side_effect=RuntimeError('pipe broke')),
    )

    svc._execute_command('cmd-4', {'type': 'mcp_tool_call'})

    svc._mark_command_cancelled.assert_called_once_with(
        'cmd-4', 'cancelled by user', None, 'mcp_tool_call'
    )
    svc._mark_command_failed.assert_not_called()
    assert svc._cancelled_commands == set()


# ─── firebase_client: restart marks running → failed ────────────────────────


def _make_seed_client(completed_data):
    from firebase_client import FirebaseClient
    svc = SimpleNamespace(
        logger=MagicMock(),
        db=MagicMock(),
        site_id='site-1',
        machine_id='mach-1',
        _seen_commands=set(),
        _mark_command_failed=MagicMock(),
    )
    svc.db.get_document.return_value = completed_data
    svc._seed_seen_commands = FirebaseClient._seed_seen_commands.__get__(svc, FirebaseClient)
    return svc


def test_seed_marks_interrupted_running_commands_failed():
    svc = _make_seed_client({
        'done-1': {'status': 'completed', 'result': 'ok'},
        'inflight-1': {'status': 'running', 'type': 'mcp_tool_call'},
        'weird': 'not-a-dict',
    })

    svc._seed_seen_commands()

    assert svc._seen_commands == {'done-1', 'inflight-1', 'weird'}
    svc._mark_command_failed.assert_called_once_with(
        'inflight-1', 'interrupted by service restart', None, 'mcp_tool_call'
    )


def test_seed_forwards_deployment_id_for_interrupted_deployment():
    """An interrupted deployment's running marker now carries deployment_id/type,
    so the failed marker seeded on restart forwards them — the deploymentStatus
    cloud function keys off deployment_id and would otherwise strand the
    deployment 'in_progress'."""
    svc = _make_seed_client({
        'dep-inflight': {
            'status': 'running',
            'deployment_id': 'dep-9',
            'type': 'install_software',
        },
    })

    svc._seed_seen_commands()

    svc._mark_command_failed.assert_called_once_with(
        'dep-inflight', 'interrupted by service restart', 'dep-9', 'install_software'
    )


def test_seed_with_empty_completed_doc_is_noop():
    svc = _make_seed_client(None)

    svc._seed_seen_commands()

    assert svc._seen_commands == set()
    svc._mark_command_failed.assert_not_called()
