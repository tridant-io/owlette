"""Local hoot cannot change what a machine launches.

It runs its own tools with nobody to approve them and no web gate in the way, so
it is offered no tool that changes a launch or runs code, and the service refuses
the one such command the queue used to carry. The queue is group-writable, so the
refusal has to hold for a command no hoot wrote.
"""

from unittest.mock import MagicMock

import pytest


def _names(tools):
    return {t.name for t in tools}


def test_local_hoot_is_not_offered_set_launch_mode():
    import cortex_tools

    names = _names(cortex_tools._make_tier2_tools())
    assert 'set_launch_mode' not in names
    assert {'restart_process', 'kill_process', 'start_process', 'capture_screenshot'} <= names


@pytest.mark.parametrize('name', ['run_command', 'run_powershell', 'execute_script', 'write_file'])
def test_a_raised_max_tier_offers_local_hoot_nothing_that_runs_code(name):
    import cortex_tools

    assert name not in _names(cortex_tools._make_tier3_tools({}))


def test_a_raised_max_tier_still_reads():
    import cortex_tools

    assert _names(cortex_tools._make_tier3_tools({})) == {'read_file', 'list_directory'}


@pytest.mark.parametrize('params', [
    {'process_name': 'TouchDesigner', 'mode': 'always'},
    {'process_name': 'TouchDesigner', 'mode': 'scheduled', 'schedules': []},
])
def test_the_service_refuses_a_queued_set_launch_mode(params):
    import owlette_service

    cmd = {'id': 'c1', 'tool_name': 'set_launch_mode', 'tool_params': params}
    assert owlette_service._cortex_command_refusal(cmd, {'touchdesigner'}) == 'unknown tool'


def test_the_service_has_no_handler_left_for_it(monkeypatch):
    from types import SimpleNamespace

    import owlette_service

    save = MagicMock()
    monkeypatch.setattr(owlette_service.shared_utils, 'save_config', save)
    svc = SimpleNamespace()
    run = owlette_service.OwletteService._execute_cortex_command.__get__(svc, owlette_service.OwletteService)

    result = run('set_launch_mode', {'process_name': 'TouchDesigner', 'mode': 'always'})

    assert 'error' in result
    save.assert_not_called()


def test_the_agent_says_it_has_the_gate():
    """The server routes a conversation to local hoot only on this capability, so
    a fielded agent that still has the tool never receives one."""
    import inspect

    import firebase_client

    assert "'capabilities.localHootLaunchGate': 1" in inspect.getsource(firebase_client)


def test_the_constitution_names_no_tool_local_hoot_does_not_have():
    """agent/CLAUDE.md is what local hoot reads. Pointing it at a tool it was never
    offered sends it looking for a way round, and tells it a shell is on the table."""
    import re
    from pathlib import Path

    text = (Path(__file__).parents[2] / 'CLAUDE.md').read_text(encoding='utf-8')
    for name in ('run_command', 'run_powershell', 'run_python', 'execute_script', 'write_file',
                 'set_launch_mode', 'manage_process', 'manage_windows_service', 'manage_scheduled_task',
                 'registry_operation', 'manage_windows_feature', 'configure_gpu_tdr', 'configure_power_plan',
                 'network_reset', 'clean_disk_space', 'show_notification', 'manage_notifications',
                 'suppress_setup_screens', 'get_event_logs_filtered'):
        assert not re.search(rf'\b{name}\b', text), f'agent/CLAUDE.md still names {name}'
