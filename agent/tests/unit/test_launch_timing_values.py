"""`time_delay` and `time_to_init` are strings a person typed, read at every launch.

Both were handed straight to `float()` inside `_launch_locked`. The dashboard's
edit form sends `''` for a cleared number field and the API takes any string,
so one cleared "launch delay" raised there. The main loop has no `except`
around `handle_process`, so the raise ended the agent, owlette-host (launchd,
systemd) relaunched it into the same config, and nothing on the machine was
supervised.

The real method is bound onto a SimpleNamespace via the descriptor protocol
(matching test_relaunch_attempts_unlimited.py) so the production body runs
without constructing the service. owlette_service is imported lazily so
collection order cannot double-initialise the cryptography PyO3 bindings.
"""

import datetime
import sys
from types import SimpleNamespace
from unittest.mock import MagicMock

import pytest


def _launch(monkeypatch, typed, since_last_launch):
    """Run `_launch_locked` for an entry whose last launch was that long ago."""
    import owlette_service
    from owlette_service import OwletteService

    entry = {'id': 'proc-1', 'name': 'Demo App', 'exe_path': sys.executable, **typed}
    monkeypatch.setattr(
        owlette_service.shared_utils, 'read_config',
        lambda keys=None, process_list_id=None: entry.get(keys[0]) if keys else {})
    now = datetime.datetime.now()
    svc = SimpleNamespace(
        last_started={'proc-1': {
            'time': now - datetime.timedelta(seconds=since_last_launch), 'pid': None}},
        current_time=now,
        reached_max_relaunch_attempts=MagicMock(return_value=False),
        launch_process_as_user=MagicMock(return_value=4242),
        firebase_client=None,
        _seat_absent=lambda: False,
        _seatless_entries=set(),
        _skip_launch_delay={'proc-1'},
    )
    launch = OwletteService._launch_locked.__get__(svc, OwletteService)
    return launch(entry, None), svc


@pytest.mark.parametrize('typed', [
    {'time_delay': '', 'time_to_init': '10'},      # a cleared "launch delay"
    {'time_delay': '0', 'time_to_init': ''},       # a cleared "init timeout"
    {'time_delay': 'soon', 'time_to_init': 'abc'},
    {'time_delay': None, 'time_to_init': None},
    {'time_delay': '-5', 'time_to_init': 'nan'},
    {},                                            # an entry with neither key
])
def test_a_value_float_refuses_falls_back_to_the_default(monkeypatch, typed):
    # one second after a launch is inside the default window: nothing launches
    pid, svc = _launch(monkeypatch, typed, since_last_launch=1)
    assert pid is None
    svc.launch_process_as_user.assert_not_called()

    # and past it, the launch goes ahead
    pid, svc = _launch(monkeypatch, typed, since_last_launch=61)
    assert pid == 4242


def test_a_typed_init_timeout_still_decides_the_window(monkeypatch):
    typed = {'time_delay': '0', 'time_to_init': '10'}

    pid, _ = _launch(monkeypatch, typed, since_last_launch=5)
    assert pid is None

    pid, _ = _launch(monkeypatch, typed, since_last_launch=11)
    assert pid == 4242


@pytest.mark.parametrize('value, expected', [
    ('2.5', 2.5), (7, 7.0), ('0', 0.0),
    ('', 60), (None, 60), ('abc', 60), ('-1', 60), ('nan', 60), ('inf', 60), ([], 60),
])
def test_seconds(value, expected):
    import owlette_service

    assert owlette_service._seconds(value, 60) == expected


def test_no_launch_path_hands_a_typed_value_straight_to_float():
    # handle_process reads time_to_init too, on its cooldown and running
    # branches. the cases above only drive _launch_locked, so the shape is
    # pinned here for both.
    import inspect
    import re

    from owlette_service import OwletteService

    for method in (OwletteService._launch_locked, OwletteService.handle_process):
        source = inspect.getsource(method)
        assert 'time_to_init' in source
        assert not re.search(r'float\(.*time_(delay|to_init)', source)
