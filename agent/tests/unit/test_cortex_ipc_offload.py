"""The Cortex IPC pump must not execute on the 5-second main service loop,
and must not execute at all with hoot switched off.

Until 2026-09-07 `_process_cortex_ipc_commands` ran the tool inline on the tick.
A single `capture_screenshot` costs ~55s end to end (user-session poll plus the
upload POST), so one screenshot stalled process monitoring, the heartbeat and
every other loop duty for that whole window — the blocking-the-main-loop
landmine, in the place that hit it most reliably.

Method bound onto a SimpleNamespace via the descriptor protocol, matching
test_cortex_process_command.py, so the production body runs without building a
Windows service.
"""

import json
import threading
import time
from types import SimpleNamespace

import pytest


@pytest.fixture
def cortex_enabled(monkeypatch):
    """The kill switch the drain is gated on, on."""
    import shared_utils

    monkeypatch.setattr(shared_utils, 'is_cortex_enabled', lambda config=None: True)


@pytest.fixture
def ipc_dirs(tmp_path, monkeypatch, cortex_enabled):
    import shared_utils

    cmd_dir = tmp_path / 'cortex_commands'
    cmd_dir.mkdir()
    (cmd_dir / 'c1.json').write_text(
        json.dumps({'id': 'c1', 'tool_name': 'capture_screenshot', 'tool_params': {}}),
        encoding='utf-8',
    )
    monkeypatch.setattr(shared_utils, 'CORTEX_IPC_CMD_DIR', str(cmd_dir), raising=False)
    monkeypatch.setattr(
        shared_utils, 'CORTEX_IPC_RESULT_DIR', str(tmp_path / 'results'), raising=False
    )
    return cmd_dir


def _dispatcher(svc):
    from owlette_service import OwletteService

    return OwletteService._process_cortex_ipc_commands.__get__(svc, OwletteService)


def test_dispatcher_returns_without_running_the_command(ipc_dirs):
    running = threading.Event()
    release = threading.Event()

    def slow_drain():
        running.set()
        release.wait(30)

    svc = SimpleNamespace(_cortex_ipc_thread=None, _drain_cortex_ipc_commands=slow_drain)

    try:
        started = time.monotonic()
        _dispatcher(svc)()
        elapsed = time.monotonic() - started

        assert running.wait(5), 'drain worker never started'
        # THE negative control. Against the previous inline body this is the
        # assertion that fails: the tick returned only after the tool finished,
        # ~30s here and ~55s for a real screenshot.
        assert elapsed < 2, f'dispatcher blocked the loop for {elapsed:.1f}s'
    finally:
        release.set()


def test_single_flight_while_a_drain_is_in_progress(ipc_dirs):
    release = threading.Event()
    starts = []

    def slow_drain():
        starts.append(1)
        release.wait(30)

    svc = SimpleNamespace(_cortex_ipc_thread=None, _drain_cortex_ipc_commands=slow_drain)

    try:
        dispatch = _dispatcher(svc)
        dispatch()
        first = svc._cortex_ipc_thread
        assert first is not None

        # Ticks land every 5s; without this guard each one would spawn another
        # worker and the serial order Cortex expects would be gone.
        dispatch()
        assert svc._cortex_ipc_thread is first
    finally:
        release.set()

    assert len(starts) == 1


def test_nothing_is_drained_with_hoot_switched_off(ipc_dirs, monkeypatch):
    """The queue is group-writable so the console user's hoot process can
    write to it. With hoot off nothing legitimate does, and a command
    hand-written there by any member of that group would otherwise run as
    root on the next tick.

    ipc_dirs has already written one; the kill switch is what stops it.
    """
    import shared_utils

    monkeypatch.setattr(shared_utils, 'is_cortex_enabled', lambda config=None: False)

    svc = SimpleNamespace(
        _cortex_ipc_thread=None,
        _drain_cortex_ipc_commands=lambda: pytest.fail('drained with hoot off'),
    )
    _dispatcher(svc)()

    assert svc._cortex_ipc_thread is None
    # Negative control: the same command IS picked up with hoot on, so the
    # switch is what refused it and not an empty queue.
    monkeypatch.setattr(shared_utils, 'is_cortex_enabled', lambda config=None: True)
    drained = []
    svc._drain_cortex_ipc_commands = lambda: drained.append(1)
    _dispatcher(svc)()
    svc._cortex_ipc_thread.join(5)
    assert drained == [1]


def test_no_worker_spawned_when_there_is_nothing_to_drain(
        tmp_path, monkeypatch, cortex_enabled):
    import shared_utils

    empty = tmp_path / 'empty'
    empty.mkdir()
    # A staged .tmp must not count: the writer renames it into place only once
    # the command is complete, so picking it up reads a half-written file.
    (empty / 'c2.json.tmp').write_text('{}', encoding='utf-8')
    monkeypatch.setattr(shared_utils, 'CORTEX_IPC_CMD_DIR', str(empty), raising=False)

    svc = SimpleNamespace(
        _cortex_ipc_thread=None,
        _drain_cortex_ipc_commands=lambda: pytest.fail('drained with no command'),
    )
    _dispatcher(svc)()
    assert svc._cortex_ipc_thread is None
