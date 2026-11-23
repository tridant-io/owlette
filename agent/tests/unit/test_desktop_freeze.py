"""A desktop app that has stopped running without exiting.

macOS suspended the app on a Mac that ran out of application memory and never
resumed it (2026-11-21). The pid stayed and its state read as sleeping, so the
watch goes by the one thing a suspended process cannot do: switch context.

The suspended child here is a real one. `suspend()` is SIGSTOP off Windows,
standing in for the system's own suspend: the kernel reports the two
differently (`T` against `S`), and the watch reads neither.
"""

import subprocess
import sys
import time
from types import SimpleNamespace

import psutil
import pytest

import desktop_freeze
from desktop_freeze import FLAT_READS_TO_FROZEN, FreezeWatch

# busy enough that two reads a moment apart always differ, as the app's tray
# thread is.
_TICKING = 'import time\nwhile True:\n    time.sleep(0.005)\n'
# a windows venv's python.exe is a launcher that waits on the real interpreter,
# and the loop has to run in the process the test holds.
_PYTHON = getattr(sys, '_base_executable', None) or sys.executable


@pytest.fixture
def child():
    process = subprocess.Popen([_PYTHON, '-c', _TICKING])
    try:
        yield psutil.Process(process.pid)
    finally:
        process.kill()
        process.wait(10)


def reads(pid, count, gap=0.2):
    taken = []
    for _ in range(count):
        taken.append(desktop_freeze.read_activity(pid))
        time.sleep(gap)
    return taken


class TestReadActivity:
    def test_a_running_process_keeps_switching(self, child):
        first, *_, last = reads(child.pid, 4)
        assert first[0] == last[0] == child.create_time()
        assert last[1] > first[1]

    def test_a_suspended_process_stands_still(self, child):
        reads(child.pid, 2)
        child.suspend()
        # the suspend is itself the last switch it makes.
        time.sleep(0.3)
        taken = reads(child.pid, 4)
        assert taken[0] is not None
        assert len(set(taken)) == 1

        child.resume()
        time.sleep(0.3)
        assert desktop_freeze.read_activity(child.pid)[1] > taken[0][1]

    def test_a_process_that_is_gone_has_no_answer(self, child):
        pid = child.pid
        child.kill()
        child.wait(10)
        assert desktop_freeze.read_activity(pid) is None


class TestFreezeWatch:
    def test_a_process_that_keeps_switching_is_never_frozen(self):
        watch = FreezeWatch()
        assert not any(watch.frozen(7, (100.0, count)) for count in range(50))

    def test_frozen_once_the_count_has_stood_still_for_the_flat_reads(self):
        watch = FreezeWatch()
        verdicts = [watch.frozen(7, (100.0, 5)) for _ in range(FLAT_READS_TO_FROZEN + 1)]
        assert verdicts == [False] * FLAT_READS_TO_FROZEN + [True]

    def test_one_switch_starts_the_count_again(self):
        watch = FreezeWatch()
        for _ in range(FLAT_READS_TO_FROZEN):
            watch.frozen(7, (100.0, 5))
        verdicts = [watch.frozen(7, (100.0, 6)) for _ in range(FLAT_READS_TO_FROZEN + 1)]
        assert verdicts == [False] * FLAT_READS_TO_FROZEN + [True]

    def test_another_process_under_the_pid_starts_the_count_again(self):
        watch = FreezeWatch()
        for _ in range(FLAT_READS_TO_FROZEN):
            watch.frozen(7, (100.0, 5))
        assert not watch.frozen(7, (200.0, 5))

    def test_a_read_with_no_answer_starts_the_count_again(self):
        watch = FreezeWatch()
        for _ in range(FLAT_READS_TO_FROZEN):
            watch.frozen(7, (100.0, 5))
        assert not watch.frozen(7, None)
        assert not watch.frozen(7, (100.0, 5))

    def test_no_process_is_never_frozen(self):
        watch = FreezeWatch()
        assert not any(watch.frozen(None, None) for _ in range(FLAT_READS_TO_FROZEN * 3))

    def test_frozen_until_it_moves_or_the_watch_is_reset(self):
        watch = FreezeWatch()
        for _ in range(FLAT_READS_TO_FROZEN):
            watch.frozen(7, (100.0, 5))
        assert watch.frozen(7, (100.0, 5))
        assert watch.frozen(7, (100.0, 5))

        watch.reset()
        assert not watch.frozen(7, (100.0, 5))


class FakeProcess:
    """The psutil surface restart() uses, recording what was done to it."""

    def __init__(self, started=100.0, uid=501, dies=True):
        self.started = started
        self.uid = uid
        self.dies = dies
        self.killed = False

    def create_time(self):
        return self.started

    def uids(self):
        return SimpleNamespace(real=self.uid, effective=self.uid, saved=self.uid)

    def kill(self):
        self.killed = True

    def wait(self, timeout=None):
        if not self.dies:
            raise psutil.TimeoutExpired(timeout)


class Launchd:
    """`subprocess.run` for launchctl, recording each command."""

    def __init__(self, returncode=0, raises=None):
        self.returncode = returncode
        self.raises = raises
        self.commands = []

    def __call__(self, command, **kwargs):
        self.commands.append(command)
        if self.raises is not None:
            raise self.raises
        return SimpleNamespace(returncode=self.returncode, stdout='', stderr='refused')


class TestRestart:
    @pytest.fixture
    def app(self, monkeypatch):
        process = FakeProcess()
        monkeypatch.setattr(desktop_freeze.psutil, 'Process', lambda pid: process)
        return process

    @pytest.fixture
    def launchd(self, monkeypatch):
        launchd = Launchd()
        monkeypatch.setattr(desktop_freeze.subprocess, 'run', launchd)
        return launchd

    def test_kills_the_frozen_app_and_has_launchd_start_one_in_its_users_session(self, app, launchd):
        assert desktop_freeze.restart(4242, 100.0) is True
        assert app.killed
        assert launchd.commands == [['launchctl', 'kickstart', 'gui/501/app.owlette.desktop']]

    def test_a_pid_that_has_changed_hands_is_left_alone(self, app, launchd):
        assert desktop_freeze.restart(4242, 99.0) is False
        assert not app.killed
        assert launchd.commands == []

    def test_an_app_that_has_gone_is_launchds_own_to_replace(self, monkeypatch, launchd):
        def gone(pid):
            raise psutil.NoSuchProcess(pid)

        monkeypatch.setattr(desktop_freeze.psutil, 'Process', gone)
        assert desktop_freeze.restart(4242, 100.0) is False
        assert launchd.commands == []

    def test_an_app_that_will_not_die_is_not_given_a_second_instance(self, app, launchd):
        app.dies = False
        assert desktop_freeze.restart(4242, 100.0) is False
        assert app.killed
        assert launchd.commands == []

    def test_a_refusal_from_launchd_is_a_failure(self, app, launchd):
        launchd.returncode = 113
        assert desktop_freeze.restart(4242, 100.0) is False

    def test_a_launchctl_that_does_not_answer_is_a_failure(self, app, launchd):
        launchd.raises = subprocess.TimeoutExpired('launchctl', 30)
        assert desktop_freeze.restart(4242, 100.0) is False
