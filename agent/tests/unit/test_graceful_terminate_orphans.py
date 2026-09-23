"""Regression tests for M2 — a .bat/.cmd restart leaving its payload running.

A script target cannot be started with CreateProcess (WinError 193), so
process_launcher wraps it in `cmd.exe /s /c ...`. The pid Owlette tracks is
therefore the wrapper, not the payload. graceful_terminate killed exactly that
one pid, so a restart reported success while the real process kept running —
still holding its port, its GPU, or its files — and untracked, because the
adoption scan looks for a live cmd.exe whose command line contains the script.

The fix snapshots descendants while the wrapper is alive and reaps the
survivors after it dies. It is opt-in via exe_path: for a normal .exe the
tracked pid IS the application, and its children are its own business.
"""

import os
import subprocess
import sys
import tempfile
import time

import psutil
import pytest

pytestmark = pytest.mark.windows(reason='windows-only process semantics')


def _make_script(tmpdir):
    """A .bat whose payload outlives its wrapper unless something reaps it."""
    path = os.path.join(tmpdir, 'probe.bat')
    with open(path, 'w') as f:
        f.write('@echo off\r\nping -n 60 127.0.0.1 > nul\r\n')
    return path


def _launch_wrapper(script):
    """Mirror process_launcher's hidden-script launch: cmd.exe /s /c."""
    si = subprocess.STARTUPINFO()
    si.dwFlags = subprocess.STARTF_USESHOWWINDOW
    si.wShowWindow = 0
    return subprocess.Popen(
        f'cmd.exe /s /c "{script}"',
        startupinfo=si,
        creationflags=subprocess.CREATE_NO_WINDOW,
    )


def _descendants(pid):
    try:
        return [(c.pid, c.name()) for c in psutil.Process(pid).children(recursive=True)]
    except psutil.Error:
        return []


def _wait_for_payload(pid, timeout=15):
    """The payload appears a moment after cmd.exe starts."""
    deadline = time.time() + timeout
    while time.time() < deadline:
        kids = _descendants(pid)
        if any(n.lower() == 'ping.exe' for _, n in kids):
            return kids
        time.sleep(0.25)
    return _descendants(pid)


def _survivors(snapshot):
    alive = []
    for cpid, name in snapshot:
        try:
            if psutil.Process(cpid).is_running():
                alive.append((cpid, name))
        except psutil.Error:
            continue
    return alive


def _cleanup(pids):
    for p in pids:
        try:
            psutil.Process(p).kill()
        except psutil.Error:
            pass


@pytest.fixture
def script():
    with tempfile.TemporaryDirectory() as tmp:
        yield _make_script(tmp)


def test_script_target_reaps_its_payload(script):
    """exe_path given -> the payload behind the wrapper dies with it."""
    sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', '..', 'src'))
    import shared_utils

    proc = _launch_wrapper(script)
    kids = _wait_for_payload(proc.pid)
    assert any(n.lower() == 'ping.exe' for _, n in kids), \
        'payload never started — test setup is broken, not the code'

    try:
        shared_utils.graceful_terminate(proc.pid, timeout=2, exe_path=script)
        time.sleep(1.0)
        alive = _survivors(kids)
        assert not alive, f'payload survived the restart: {alive}'
    finally:
        _cleanup([p for p, _ in kids] + [proc.pid])


def test_negative_control_without_exe_path_the_payload_survives(script):
    """The pre-fix behaviour, pinned.

    Without exe_path graceful_terminate kills only the wrapper — which is
    exactly the bug. If this ever starts passing, the reap has silently become
    unconditional, and that is its own defect: it would race a healthy app's
    own child cleanup (TouchDesigner tears down TouchEngine.exe itself).
    """
    sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', '..', 'src'))
    import shared_utils

    proc = _launch_wrapper(script)
    kids = _wait_for_payload(proc.pid)
    assert any(n.lower() == 'ping.exe' for _, n in kids)

    try:
        shared_utils.graceful_terminate(proc.pid, timeout=2)
        time.sleep(1.0)
        alive = _survivors(kids)
        assert any(n.lower() == 'ping.exe' for _, n in alive), \
            'payload died without exe_path — the reap is no longer opt-in'
    finally:
        _cleanup([p for p, _ in kids] + [proc.pid])


def test_exe_target_leaves_children_alone(script):
    """A non-script exe_path must not trigger reaping."""
    sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', '..', 'src'))
    import shared_utils

    proc = _launch_wrapper(script)
    kids = _wait_for_payload(proc.pid)
    assert any(n.lower() == 'ping.exe' for _, n in kids)

    try:
        # exe_path present but not a script — reaping must stay off
        shared_utils.graceful_terminate(
            proc.pid, timeout=2, exe_path=r'C:\Program Files\Whatever\app.exe')
        time.sleep(1.0)
        alive = _survivors(kids)
        assert any(n.lower() == 'ping.exe' for _, n in alive), \
            'reaping fired for a non-script target'
    finally:
        _cleanup([p for p, _ in kids] + [proc.pid])
