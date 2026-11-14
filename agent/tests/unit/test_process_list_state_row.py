"""`get_process_list` reports the state row the dashboard reports.

A restart leaves the terminated pid's KILLED row in app_states.json until the
service's next cleanup, up to five minutes later, ahead of the relaunch's row.
The tool took the first row for a process, so for those minutes it told hoot
that a process it had just restarted was not running, while the dashboard,
which takes the last row, showed it running. A failed launch's "None" key made
the tool raise instead of answering.
"""

import os
import subprocess
import sys

import pytest

CONFIG = {
    'processes': [
        {'id': 'lab-sleep', 'name': 'lab-sleep', 'exe_path': '/usr/bin/sleep', 'autolaunch': True},
    ],
}


@pytest.fixture
def dead_pid():
    """the pid of a process that has exited."""
    finished = subprocess.Popen([sys.executable, '-c', 'pass'])
    finished.wait()
    return finished.pid


@pytest.fixture
def listed(monkeypatch):
    """`get_process_list`'s one entry, with app_states.json holding `rows`."""
    import mcp_tools

    def run(rows):
        monkeypatch.setattr(mcp_tools.shared_utils, 'read_json_from_file', lambda path: rows)
        result = mcp_tools._get_process_list({}, CONFIG)
        assert result['count'] == 1
        return result['processes'][0]

    return run


def test_a_restarted_process_is_reported_from_its_new_row(listed, dead_pid):
    entry = listed({
        str(dead_pid): {'id': 'lab-sleep', 'status': 'KILLED', 'timestamp': 100},
        str(os.getpid()): {'id': 'lab-sleep', 'status': 'RUNNING', 'timestamp': 147},
    })

    assert entry['running'] is True
    assert entry['pid'] == os.getpid()
    assert entry['status'] == 'RUNNING'


def test_a_row_for_a_pid_that_is_gone_is_not_running(listed, dead_pid):
    entry = listed({str(dead_pid): {'id': 'lab-sleep', 'status': 'KILLED', 'timestamp': 100}})

    assert entry['running'] is False
    assert entry['pid'] is None
    assert entry['status'] == 'KILLED'


def test_a_failed_launch_row_does_not_break_the_list(listed):
    entry = listed({'None': {'id': 'lab-sleep', 'status': 'LAUNCHING'}})

    assert entry['running'] is False
    assert entry['pid'] is None
    assert entry['status'] == 'unknown'


def test_a_failed_launch_row_does_not_hide_the_running_one(listed):
    entry = listed({
        str(os.getpid()): {'id': 'lab-sleep', 'status': 'RUNNING', 'timestamp': 147},
        'None': {'id': 'lab-sleep', 'status': 'LAUNCHING'},
    })

    assert entry['running'] is True
    assert entry['pid'] == os.getpid()


def test_another_process_s_row_is_not_taken(listed):
    entry = listed({str(os.getpid()): {'id': 'lab-xterm', 'status': 'RUNNING', 'timestamp': 147}})

    assert entry['running'] is False
    assert entry['status'] == 'unknown'


def test_the_last_row_speaks_for_a_process():
    import shared_utils

    rows = shared_utils.state_rows_by_process({
        '11': {'id': 'a', 'status': 'KILLED'},
        '12': {'id': 'b', 'status': 'RUNNING'},
        '13': {'id': 'a', 'status': 'RUNNING'},
        'None': {'id': 'a', 'status': 'LAUNCHING'},
        '14': 'not a row',
        '15': {'status': 'RUNNING'},
    })

    assert rows == {
        'a': (13, {'id': 'a', 'status': 'RUNNING'}),
        'b': (12, {'id': 'b', 'status': 'RUNNING'}),
    }
    assert shared_utils.state_rows_by_process(None) == {}
