"""Unit tests for sleep_watch.

Every OS seam is a fake, so the suite runs on all three platforms and nothing
is ever registered with a real power manager. What matters most: a sleep is
answered whatever the announce does, and a dark wake never reads as awake.
"""

import datetime
import threading
import time

import pytest

import sleep_watch
from sleep_watch import IOKitSystemPower, SleepWatch

FIRST_SLEEP = datetime.datetime(2026, 11, 20, 2, 26, 10)
NEXT_SLEEP = datetime.datetime(2026, 11, 20, 3, 40, 0)


class FakeBackend:
    """A listener stand-in: the test fires the system's messages by hand."""

    def __init__(self, awake=True, listen_error=None):
        self.awake = awake
        self.listen_error = listen_error
        self.listening = threading.Event()
        self.will_sleep = None
        self.powered_on = None

    def listen(self, will_sleep, powered_on):
        self.will_sleep, self.powered_on = will_sleep, powered_on
        if self.listen_error:
            raise self.listen_error
        self.listening.set()

    def fully_awake(self):
        return self.awake


def wait_for(predicate, timeout=3.0):
    """Poll ``predicate`` until true; the listener is on its own thread."""
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if predicate():
            return True
        time.sleep(0.01)
    return False


@pytest.fixture(autouse=True)
def clock(monkeypatch):
    """Each will-sleep from a full wake reads the next of these times."""
    times = iter([FIRST_SLEEP, NEXT_SLEEP])
    monkeypatch.setattr(sleep_watch, '_utcnow', lambda: next(times))


def started(backend, announce=None):
    """A listening watch whose announce records the sleep time it would write."""
    calls = []
    watch = SleepWatch(backend)
    watch.start(announce or (lambda: calls.append(watch.asleep_since())))
    assert backend.listening.wait(3)
    return watch, calls


def test_nothing_listens_where_there_is_no_backend():
    watch = SleepWatch()
    # what _platform_backend gives off a mac, on whichever platform this runs.
    watch._backend = None
    watch.start(lambda: None)

    assert watch.supported is False
    assert watch.listening is False
    assert watch.asleep_since() is None


def test_a_sleep_announces_and_reads_asleep_since_it_began():
    backend = FakeBackend()
    watch, calls = started(backend)

    backend.will_sleep()

    assert calls == [FIRST_SLEEP]
    assert watch.asleep_since() == FIRST_SLEEP


def test_the_real_clock_is_naive_utc(monkeypatch):
    # the rest client appends Z to isoformat(): an aware time would not parse.
    monkeypatch.undo()
    now = sleep_watch._utcnow()

    assert now.tzinfo is None
    assert abs(now - datetime.datetime.now(datetime.timezone.utc).replace(tzinfo=None)) < datetime.timedelta(seconds=5)


def test_still_asleep_on_the_way_down_though_the_displays_read_on():
    # before the system says it powered on, a capability read can still see the
    # displays of the machine that is going to sleep.
    backend = FakeBackend(awake=True)
    watch, _ = started(backend)

    backend.will_sleep()

    assert watch.asleep_since() == FIRST_SLEEP


def test_a_dark_wake_stays_asleep_and_its_return_to_sleep_keeps_the_time():
    backend = FakeBackend()
    watch, calls = started(backend)
    backend.will_sleep()

    backend.awake = False
    backend.powered_on()
    assert watch.asleep_since() == FIRST_SLEEP

    backend.will_sleep()
    assert calls == [FIRST_SLEEP, FIRST_SLEEP]


def test_a_full_wake_is_awake_and_the_next_sleep_has_its_own_time():
    backend = FakeBackend()
    watch, calls = started(backend)
    backend.will_sleep()

    backend.awake = True
    backend.powered_on()
    assert watch.asleep_since() is None

    backend.will_sleep()
    assert calls == [FIRST_SLEEP, NEXT_SLEEP]


def test_a_dark_wake_that_turns_full_reads_awake():
    backend = FakeBackend(awake=False)
    watch, _ = started(backend)
    backend.will_sleep()
    backend.powered_on()
    assert watch.asleep_since() == FIRST_SLEEP

    backend.awake = True
    assert watch.asleep_since() is None


def test_a_stalled_announce_never_holds_the_sleep_past_the_wait(monkeypatch):
    monkeypatch.setattr(sleep_watch, 'ANNOUNCE_WAIT_SECONDS', 0.1)
    release = threading.Event()
    backend = FakeBackend()
    watch, _ = started(backend, announce=lambda: release.wait(5))

    began = time.monotonic()
    backend.will_sleep()
    took = time.monotonic() - began
    release.set()

    assert took < 1
    assert watch.asleep_since() == FIRST_SLEEP


def test_a_failed_announce_still_reads_asleep():
    def refuse():
        raise RuntimeError('no network')

    backend = FakeBackend()
    watch, _ = started(backend, announce=refuse)

    backend.will_sleep()

    assert watch.asleep_since() == FIRST_SLEEP


def test_a_listener_that_fails_stops_listening():
    backend = FakeBackend(listen_error=RuntimeError('IORegisterForSystemPower failed'))
    watch = SleepWatch(backend)
    watch.start(lambda: None)

    assert watch.supported is True
    assert wait_for(lambda: watch.listening is False)


# --------------------------------------------------------------------- macOS

CAN_SLEEP, WILL_SLEEP, WILL_NOT_SLEEP, HAS_POWERED_ON = 0xE0000270, 0xE0000280, 0xE0000290, 0xE0000300
ROOT_PORT = 0x1F03


class FakeIOKit:
    def __init__(self, root=ROOT_PORT):
        self.root = root
        self.callback = None
        self.allowed = []

    def IORegisterForSystemPower(self, refcon, port, callback, notifier):
        self.callback = callback
        return self.root

    def IONotificationPortGetRunLoopSource(self, port):
        return 'source'

    def IOAllowPowerChange(self, root, argument):
        self.allowed.append((root, argument))
        return 0


class FakeCoreFoundation:
    """Runs the loop by delivering ``messages`` through the registered callback."""

    def __init__(self, iokit, messages):
        self.iokit = iokit
        self.messages = messages
        self.sources = []

    def CFRunLoopGetCurrent(self):
        return 'loop'

    def CFRunLoopAddSource(self, loop, source, mode):
        self.sources.append((loop, source, mode))

    def CFRunLoopRun(self):
        for message, argument in self.messages:
            self.iokit.callback(None, 0, message, argument)


def run_listener(messages, will_sleep=None, powered_on=None):
    iokit = FakeIOKit()
    cf = FakeCoreFoundation(iokit, messages)
    calls = []
    IOKitSystemPower(frameworks=(iokit, cf, 'default-mode')).listen(
        will_sleep or (lambda: calls.append('will_sleep')),
        powered_on or (lambda: calls.append('powered_on')),
    )
    return iokit, cf, calls


def test_the_listener_serves_the_power_port_on_this_threads_run_loop():
    _, cf, _ = run_listener([])

    assert cf.sources == [('loop', 'source', 'default-mode')]


def test_a_will_sleep_runs_the_hook_then_lets_the_sleep_go():
    iokit, _, calls = run_listener([(WILL_SLEEP, 0x42)])

    assert calls == ['will_sleep']
    assert iokit.allowed == [(ROOT_PORT, 0x42)]


def test_a_can_sleep_is_answered_and_nothing_else():
    iokit, _, calls = run_listener([(CAN_SLEEP, 0x7)])

    assert calls == []
    assert iokit.allowed == [(ROOT_PORT, 0x7)]


def test_a_power_on_runs_its_hook_and_needs_no_answer():
    iokit, _, calls = run_listener([(HAS_POWERED_ON, 0), (WILL_NOT_SLEEP, 0)])

    assert calls == ['powered_on']
    assert iokit.allowed == []


def test_a_hook_that_raises_still_lets_the_sleep_go():
    def refuse():
        raise RuntimeError('boom')

    iokit, _, _ = run_listener([(WILL_SLEEP, 0x9)], will_sleep=refuse)

    assert iokit.allowed == [(ROOT_PORT, 0x9)]


def test_a_refused_registration_raises():
    iokit = FakeIOKit(root=0)
    cf = FakeCoreFoundation(iokit, [])

    with pytest.raises(RuntimeError, match='IORegisterForSystemPower'):
        IOKitSystemPower(frameworks=(iokit, cf, 'default-mode')).listen(lambda: None, lambda: None)


@pytest.mark.parametrize('capabilities, awake', [
    (0xF, True),    # cpu, graphics, audio, network: a full wake
    (0x9, False),   # cpu and network only: a dark wake
    (None, True),   # an unreadable registry never holds a machine asleep
])
def test_fully_awake_reads_the_graphics_capability(capabilities, awake):
    power = IOKitSystemPower(frameworks=(None, None, None), capabilities=lambda: capabilities)

    assert power.fully_awake() is awake


def test_a_capability_read_that_raises_counts_as_awake():
    # it runs inside the heartbeat, which it must never fail.
    def broken():
        raise OSError('the IORegistry did not answer')

    power = IOKitSystemPower(frameworks=(None, None, None), capabilities=broken)

    assert power.fully_awake() is True
