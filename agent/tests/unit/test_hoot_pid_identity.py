"""Which pid the service takes for hoot, and so ends on an unpair.

hoot writes its own pid to tmp/cortex.pid as the console user, and the service
reads it back after a restart; an unpair then terminates that pid as SYSTEM
(root off Windows). A pid counts as hoot only while the live process is the
bundled interpreter running owlette_cortex.py.

psutil is replaced by a fake process table; the interpreter and the script are
real files in tmp_path, because the check compares files, not spellings.
owlette_service is imported lazily, as elsewhere in this suite.
"""

import contextlib
from types import SimpleNamespace

import psutil
import pytest

import shared_utils


PID = 4242


class _Proc:
    def __init__(self, exe, cmdline, terminated):
        self._exe = exe
        self._cmdline = cmdline
        self._terminated = terminated

    def is_running(self):
        return True

    def status(self):
        return psutil.STATUS_RUNNING

    def exe(self):
        return self._exe

    def cmdline(self):
        return self._cmdline

    def oneshot(self):
        return contextlib.nullcontext()

    def terminate(self):
        self._terminated.append(PID)


@pytest.fixture
def machine(tmp_path, monkeypatch):
    """A bundled interpreter, hoot's script, a stranger's image and a pid file."""
    import owlette_service

    python = tmp_path / 'python' / 'pythonw.exe'
    src = tmp_path / 'agent' / 'src'
    stranger = tmp_path / 'security' / 'agent.exe'
    for path in (python, src / 'owlette_cortex.py', src / 'owlette_runner.py', stranger):
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text('')
    pid_file = tmp_path / 'tmp' / 'cortex.pid'
    pid_file.parent.mkdir()

    monkeypatch.setattr(shared_utils, 'get_python_exe_path', lambda: str(python))
    monkeypatch.setattr(shared_utils, 'get_path', lambda name=None: str(src / name))
    monkeypatch.setattr(shared_utils, 'CORTEX_PID_PATH', str(pid_file))
    monkeypatch.setattr(owlette_service.configure_site, 'unpair', lambda reason: None)

    table = {}
    terminated = []

    def process(pid):
        if pid not in table:
            raise psutil.NoSuchProcess(pid)
        return table[pid]

    monkeypatch.setattr(owlette_service.psutil, 'Process', process)

    def run(exe, *args):
        table[PID] = _Proc(str(exe), [str(exe), *map(str, args)], terminated)

    svc = SimpleNamespace(
        cortex_pid=None,
        _stop_swoop=lambda: None,
        fleet_session=SimpleNamespace(withdraw=lambda: None),
    )
    svc._is_cortex_alive = owlette_service.OwletteService._is_cortex_alive.__get__(svc)
    svc.unpair = owlette_service.OwletteService.unpair.__get__(svc)
    return SimpleNamespace(
        python=python, hoot=src / 'owlette_cortex.py', runner=src / 'owlette_runner.py',
        stranger=stranger, pid_file=pid_file, run=run, svc=svc, terminated=terminated)


def test_a_planted_pid_is_not_hoot_and_an_unpair_leaves_it_alone(machine):
    machine.run(machine.stranger)
    machine.pid_file.write_text(str(PID))

    assert machine.svc._is_cortex_alive() is False
    machine.svc.unpair('revoked')

    assert machine.terminated == []
    assert machine.svc.cortex_pid is None


def test_the_bundled_interpreter_running_another_script_is_not_hoot(machine):
    # the service itself, the scout and the launcher helper run on it too
    machine.run(machine.python, machine.runner)
    machine.pid_file.write_text(str(PID))

    assert machine.svc._is_cortex_alive() is False


def test_a_launched_pid_now_worn_by_another_process_is_dropped(machine):
    machine.run(machine.stranger)
    machine.svc.cortex_pid = PID

    assert machine.svc._is_cortex_alive() is False
    assert machine.svc.cortex_pid is None


def test_hoot_named_by_its_pid_file_is_ended_on_unpair(machine):
    machine.run(machine.python, machine.hoot)
    machine.pid_file.write_text(str(PID))

    assert machine.svc._is_cortex_alive() is True
    machine.svc.unpair('revoked')

    assert machine.terminated == [PID]
