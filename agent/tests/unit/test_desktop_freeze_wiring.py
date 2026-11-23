"""How the service wires the frozen desktop app watch into its loop.

The service builds through `_init_state`, as owlette_runner builds it; the
process read and the restart are fakes, so nothing is killed here. What the
loop is held to: it reads on its interval, on macOS, while the machine is
awake; it orders one restart per cooldown; and it never waits on the restart.
"""

import datetime
import sys
import threading
import time
from types import SimpleNamespace

import pytest

import owlette_service
from desktop_freeze import FLAT_READS_TO_FROZEN

APP_PID = 4242
APP_STARTED = 100.0


class App:
    """The desktop app as the watch sees it, and the restarts ordered for it."""

    def __init__(self):
        self.switches = 5
        self.running = False
        self.reads = 0
        self.restarts = []
        self.restarting = threading.Event()
        self.restarting.set()

    def read_activity(self, pid):
        self.reads += 1
        if self.running:
            self.switches += 1
        return APP_STARTED, self.switches

    def restart(self, pid, started):
        self.restarts.append((pid, started))
        self.restarting.wait(5)
        return True


@pytest.fixture
def app(monkeypatch):
    app = App()
    monkeypatch.setattr(owlette_service.desktop_freeze, 'read_activity', app.read_activity)
    monkeypatch.setattr(owlette_service.desktop_freeze, 'restart', app.restart)
    return app


@pytest.fixture
def awake(monkeypatch):
    watch = SimpleNamespace(since=None)
    watch.asleep_since = lambda: watch.since
    monkeypatch.setattr(owlette_service.sleep_watch, 'WATCH', watch)
    return watch


@pytest.fixture
def service(monkeypatch, app, awake):
    monkeypatch.setattr(
        owlette_service.shared_utils, 'read_config', lambda *a, **kw: {})
    monkeypatch.setattr(
        owlette_service.shared_utils, 'get_api_base_url',
        lambda environment=None: 'https://example.invalid/api')
    svc = object.__new__(owlette_service.OwletteService)
    svc._init_state()
    svc.tray_icon_pid = APP_PID
    monkeypatch.setattr(sys, 'platform', 'darwin')
    return svc


def check(svc, times=1):
    """That many reads' worth of loop ticks, and the restart they started, if any."""
    for _ in range(times * owlette_service.DESKTOP_FREEZE_CHECK_ITERATIONS):
        svc._check_desktop_frozen()
    worker = svc._desktop_restart_thread
    if worker is not None:
        worker.join(5)


# the first read is the one the rest are compared with.
READS_TO_FROZEN = FLAT_READS_TO_FROZEN + 1


def test_a_frozen_app_is_restarted(service, app):
    check(service, READS_TO_FROZEN - 1)
    assert app.restarts == []

    check(service)
    assert app.restarts == [(APP_PID, APP_STARTED)]


def test_a_running_app_is_left_alone(service, app):
    app.running = True
    check(service, READS_TO_FROZEN * 5)
    assert app.restarts == []


def test_the_app_is_read_once_an_interval(service, app):
    for _ in range(owlette_service.DESKTOP_FREEZE_CHECK_ITERATIONS - 1):
        service._check_desktop_frozen()
    assert app.reads == 0

    service._check_desktop_frozen()
    assert app.reads == 1


def test_an_app_frozen_again_inside_the_cooldown_waits_it_out(service, app):
    check(service, READS_TO_FROZEN * 3)
    assert len(app.restarts) == 1

    service._desktop_restarted_at -= owlette_service.DESKTOP_RESTART_COOLDOWN_SECONDS
    check(service)
    assert len(app.restarts) == 2


def test_reads_while_the_machine_sleeps_do_not_count(service, app, awake):
    awake.since = datetime.datetime(2026, 11, 21, 18, 43)
    check(service, READS_TO_FROZEN * 3)
    assert app.reads == 0
    assert app.restarts == []

    awake.since = None
    check(service, READS_TO_FROZEN - 1)
    assert app.restarts == []
    check(service)
    assert len(app.restarts) == 1


def test_a_sleep_starts_the_count_again(service, app, awake):
    check(service, READS_TO_FROZEN - 1)
    awake.since = datetime.datetime(2026, 11, 21, 18, 43)
    check(service)
    awake.since = None

    check(service, READS_TO_FROZEN - 1)
    assert app.restarts == []


@pytest.mark.parametrize('platform', ['win32', 'linux'])
def test_only_macos_is_watched(service, app, monkeypatch, platform):
    monkeypatch.setattr(sys, 'platform', platform)
    check(service, READS_TO_FROZEN * 3)
    assert app.reads == 0
    assert app.restarts == []


def test_no_app_is_nothing_to_restart(service, app):
    service.tray_icon_pid = None
    check(service, READS_TO_FROZEN * 3)
    assert app.reads == 0
    assert app.restarts == []


def test_the_tick_does_not_wait_on_the_restart(service, app):
    app.restarting.clear()
    try:
        began = time.monotonic()
        for _ in range(READS_TO_FROZEN * owlette_service.DESKTOP_FREEZE_CHECK_ITERATIONS):
            service._check_desktop_frozen()
        assert time.monotonic() - began < 1
        worker = service._desktop_restart_thread
        while not app.restarts and time.monotonic() - began < 5:
            time.sleep(0.01)
        assert app.restarts == [(APP_PID, APP_STARTED)]
        assert worker.is_alive()
    finally:
        app.restarting.set()
    service._desktop_restart_thread.join(5)
