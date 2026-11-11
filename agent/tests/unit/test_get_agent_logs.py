"""`get_agent_logs` reads the agent's own log.

It used to take whichever `.log` sorted last by name. The logs folder also
holds `submit_issue.log`, `service_stdout.log` and the installer's logs, all of
which sort after `service.log`, so on any machine where somebody had filed an
issue hoot read the issue tool's log and reported on the wrong thing.
"""

import pytest


@pytest.fixture
def logs_dir(tmp_path, monkeypatch):
    import mcp_tools

    logs = tmp_path / 'logs'
    logs.mkdir()
    monkeypatch.setattr(mcp_tools.shared_utils, 'get_data_path', lambda rel='': str(tmp_path / rel))
    return logs


def test_it_reads_service_log_whatever_else_is_in_the_folder(logs_dir):
    import mcp_tools

    (logs_dir / 'service.log').write_text('INFO started\nERROR launch failed\n', encoding='utf-8')
    (logs_dir / 'submit_issue.log').write_text('INFO zip uploaded\n', encoding='utf-8')
    (logs_dir / 'update_installer.log').write_text('INFO installed\n', encoding='utf-8')

    result = mcp_tools._get_agent_logs({}, {})

    assert result['log_file'] == 'service.log'
    assert result['lines'] == ['INFO started', 'ERROR launch failed']


def test_a_level_filter_still_applies(logs_dir):
    import mcp_tools

    (logs_dir / 'service.log').write_text('INFO started\nERROR launch failed\n', encoding='utf-8')

    assert mcp_tools._get_agent_logs({'level': 'error'}, {})['lines'] == ['ERROR launch failed']


def test_no_service_log_is_an_error_not_another_tools_log(logs_dir):
    import mcp_tools

    (logs_dir / 'submit_issue.log').write_text('INFO zip uploaded\n', encoding='utf-8')

    assert 'error' in mcp_tools._get_agent_logs({}, {})
