"""Unit tests for keep_awake.

Every OS seam is a fake, so the suite runs on all three platforms and nothing
real is ever held. The property that matters most is the service's: set_wanted
never waits on the OS.
"""

import io
import os
import subprocess
import sys
import threading
import time

import pytest

import keep_awake
from keep_awake import IOPMAssertion, KeepAwake, PowerRequest, SystemdInhibit


ACCESS_DENIED = '[WinError 5] Access is denied.'
# kIOReturnNotPrivileged, as the signed int IOKit returns it.
IOKIT_NOT_PRIVILEGED = 0xE00002C1 - 2 ** 32


def wait_for(predicate, timeout=3.0):
    """Poll ``predicate`` until true; the holder's work is on its own thread."""
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if predicate():
            return True
        time.sleep(0.01)
    return False


def settled(keeper):
    """True once the worker has acted on every change and gone."""
    return wait_for(lambda: keeper._worker is None)


class FakeBackend:
    """A mechanism stand-in that records its calls and how many overlap."""

    how = 'fake'

    def __init__(self, hold_errors=(), release_error=None, gate=None, delay=0.0):
        self.hold_errors = list(hold_errors)
        self.release_error = release_error
        self.gate = gate
        self.delay = delay
        self.holds = 0
        self.released = []
        self.entered = threading.Event()
        self.active = 0
        self.max_active = 0
        self._lock = threading.Lock()

    def _enter(self):
        with self._lock:
            self.active += 1
            self.max_active = max(self.max_active, self.active)
        self.entered.set()

    def _leave(self):
        with self._lock:
            self.active -= 1

    def hold(self):
        self._enter()
        try:
            if self.gate is not None:
                self.gate.wait(3.0)
            time.sleep(self.delay)
            self.holds += 1
            if self.hold_errors:
                raise self.hold_errors.pop(0)
            return f'handle-{self.holds}'
        finally:
            self._leave()

    def release(self, handle):
        self._enter()
        try:
            time.sleep(self.delay)
            self.released.append(handle)
            if self.release_error is not None:
                raise self.release_error
        finally:
            self._leave()


# ------------------------------------------------------------------ KeepAwake

def test_status_starts_released():
    assert KeepAwake(FakeBackend()).status() == {
        'wanted': False, 'held': False, 'how': 'fake', 'reason': None,
    }


def test_the_default_backend_is_this_platforms():
    # constructing it holds nothing: no seam is touched until set_wanted.
    expected = {'win32': 'power_request', 'darwin': 'iopm_assertion'}.get(sys.platform, 'systemd_inhibit')
    assert KeepAwake().status()['how'] == expected


def test_holding_twice_holds_once():
    backend = FakeBackend()
    keeper = KeepAwake(backend)

    keeper.set_wanted(True)
    assert settled(keeper)
    keeper.set_wanted(True)
    assert settled(keeper)

    assert backend.holds == 1
    assert keeper.status() == {'wanted': True, 'held': True, 'how': 'fake', 'reason': None}


def test_not_wanted_releases_the_hold():
    backend = FakeBackend()
    keeper = KeepAwake(backend)
    keeper.set_wanted(True)
    assert settled(keeper)

    keeper.set_wanted(False)
    assert settled(keeper)

    assert backend.released == ['handle-1']
    assert keeper.status() == {'wanted': False, 'held': False, 'how': 'fake', 'reason': None}


def test_not_wanted_with_nothing_held_touches_nothing():
    backend = FakeBackend()
    keeper = KeepAwake(backend)

    keeper.set_wanted(False)
    assert settled(keeper)

    assert backend.holds == 0
    assert backend.released == []


def test_a_failing_seam_reports_held_false_with_its_reason():
    backend = FakeBackend(hold_errors=[RuntimeError(f'PowerSetRequest: {ACCESS_DENIED}')])
    keeper = KeepAwake(backend)

    keeper.set_wanted(True)
    assert settled(keeper)

    assert keeper.status() == {
        'wanted': True, 'held': False, 'how': 'fake', 'reason': f'PowerSetRequest: {ACCESS_DENIED}',
    }


def test_an_error_without_a_message_still_has_a_reason():
    keeper = KeepAwake(FakeBackend(hold_errors=[OSError()]))

    keeper.set_wanted(True)
    assert settled(keeper)

    assert keeper.status()['reason'] == 'OSError'


def test_asking_again_retries_a_failed_hold():
    backend = FakeBackend(hold_errors=[RuntimeError('no_inhibit')])
    keeper = KeepAwake(backend)
    keeper.set_wanted(True)
    assert settled(keeper)

    keeper.set_wanted(True)
    assert settled(keeper)

    assert backend.holds == 2
    assert keeper.status() == {'wanted': True, 'held': True, 'how': 'fake', 'reason': None}


def test_not_wanted_clears_a_failed_holds_reason():
    keeper = KeepAwake(FakeBackend(hold_errors=[RuntimeError('no_inhibit')]))
    keeper.set_wanted(True)
    assert settled(keeper)

    keeper.set_wanted(False)
    assert settled(keeper)

    assert keeper.status() == {'wanted': False, 'held': False, 'how': 'fake', 'reason': None}


def test_a_failed_release_drops_the_hold_and_logs_it(caplog):
    backend = FakeBackend(release_error=RuntimeError('CloseHandle: [WinError 6] The handle is invalid.'))
    keeper = KeepAwake(backend)
    keeper.set_wanted(True)
    assert settled(keeper)

    keeper.set_wanted(False)
    assert settled(keeper)

    assert keeper.status() == {'wanted': False, 'held': False, 'how': 'fake', 'reason': None}
    assert 'release failed (fake): CloseHandle: [WinError 6]' in caplog.text


def test_set_wanted_returns_at_once_while_the_seam_is_slow():
    gate = threading.Event()
    backend = FakeBackend(gate=gate)
    keeper = KeepAwake(backend)
    try:
        started = time.monotonic()
        keeper.set_wanted(True)
        assert backend.entered.wait(3.0)
        # the seam is mid-call and stays there until the gate opens.
        keeper.set_wanted(False)
        keeper.set_wanted(True)
        assert time.monotonic() - started < 0.5
        assert keeper.status()['held'] is False
    finally:
        gate.set()

    assert settled(keeper)
    assert backend.holds == 1
    assert backend.released == []
    assert keeper.status()['held'] is True


def test_one_seam_call_at_a_time_and_the_last_ask_wins():
    backend = FakeBackend(delay=0.005)
    keeper = KeepAwake(backend)

    # paced so asks land while the seam is mid-call; asks that land together coalesce.
    for i in range(40):
        keeper.set_wanted(i % 2 == 0)
        time.sleep(0.002)
    keeper.set_wanted(True)
    assert settled(keeper)

    assert backend.max_active == 1
    assert keeper.status()['held'] is True
    assert len(backend.released) == backend.holds - 1


def test_release_waits_for_the_let_go():
    backend = FakeBackend()
    keeper = KeepAwake(backend)
    keeper.set_wanted(True)
    assert settled(keeper)

    keeper.release()

    assert backend.released == ['handle-1']
    assert keeper.status()['held'] is False


def test_release_gives_up_after_its_timeout():
    gate = threading.Event()
    keeper = KeepAwake(FakeBackend(gate=gate))
    try:
        keeper.set_wanted(True)
        started = time.monotonic()
        keeper.release(timeout=0.05)
        assert time.monotonic() - started < 1.0
    finally:
        gate.set()
    assert settled(keeper)
    assert keeper.status()['held'] is False


# -------------------------------------------------------------------- windows

class FakeKernel32:
    """kernel32's four power-request calls, recording what they were given."""

    def __init__(self, request=0x1234, failing_kinds=(), close_ok=True):
        self.request = request
        self.failing_kinds = set(failing_kinds)
        self.close_ok = close_ok
        self.calls = []
        self.contexts = []

    def PowerCreateRequest(self, context):
        reason = context.contents
        self.contexts.append((reason.Version, reason.Flags, reason.Reason.SimpleReasonString))
        self.calls.append(('create',))
        return self.request

    def PowerSetRequest(self, request, kind):
        self.calls.append(('set', request, kind))
        return 0 if kind in self.failing_kinds else 1

    def PowerClearRequest(self, request, kind):
        self.calls.append(('clear', request, kind))
        return 1

    def CloseHandle(self, request):
        self.calls.append(('close', request))
        return 1 if self.close_ok else 0


def power_request(kernel32):
    return PowerRequest(kernel32=kernel32, last_error=lambda: ACCESS_DENIED)


def test_power_request_holds_the_system_only():
    # TEC-A4D on 4.1.1, 2026-10-03: from the service's session 0, Windows
    # refuses PowerRequestDisplayRequired with ERROR_NOT_SUPPORTED, and asking
    # for it first lost the system request too. The display is the app's to
    # hold, in the user's session.
    kernel32 = FakeKernel32(failing_kinds={0})

    assert power_request(kernel32).hold() == 0x1234

    # REASON_CONTEXT version 0, POWER_REQUEST_CONTEXT_SIMPLE_STRING.
    assert kernel32.contexts == [(0, 1, 'owlette keep screens awake')]
    # PowerRequestSystemRequired, and never PowerRequestDisplayRequired.
    assert kernel32.calls == [('create',), ('set', 0x1234, 1)]


def test_power_request_release_clears_and_closes():
    kernel32 = FakeKernel32()

    power_request(kernel32).release(0x1234)

    assert kernel32.calls == [('clear', 0x1234, 1), ('close', 0x1234)]


@pytest.mark.parametrize('refused', [None, keep_awake._INVALID_HANDLE_VALUE])
def test_power_request_reports_a_refused_create(refused):
    kernel32 = FakeKernel32(request=refused)

    with pytest.raises(RuntimeError, match=r'^PowerCreateRequest: \[WinError 5\]'):
        power_request(kernel32).hold()

    assert kernel32.calls == [('create',)]


def test_power_request_closes_a_request_it_could_not_set():
    kernel32 = FakeKernel32(failing_kinds={1})

    with pytest.raises(RuntimeError, match=r'^PowerSetRequest: \[WinError 5\]'):
        power_request(kernel32).hold()

    assert kernel32.calls[-1] == ('close', 0x1234)


def test_power_request_reports_a_failed_close():
    with pytest.raises(RuntimeError, match=r'^CloseHandle: \[WinError 5\]'):
        power_request(FakeKernel32(close_ok=False)).release(0x1234)


def test_a_refused_power_request_reaches_status():
    keeper = KeepAwake(power_request(FakeKernel32(failing_kinds={1})))

    keeper.set_wanted(True)
    assert settled(keeper)

    assert keeper.status() == {
        'wanted': True, 'held': False, 'how': 'power_request',
        'reason': f'PowerSetRequest: {ACCESS_DENIED}',
    }


# ---------------------------------------------------------------------- macOS

class FakeCoreFoundation:
    """CFStrings as numbered handles, so their releases can be counted."""

    def __init__(self):
        self.strings = {}
        self.released = []

    def CFStringCreateWithCString(self, allocator, text, encoding):
        assert encoding == 0x08000100  # kCFStringEncodingUTF8
        handle = 1000 + len(self.strings)
        self.strings[handle] = text
        return handle

    def CFRelease(self, handle):
        self.released.append(handle)


class FakeIOKit:
    """The two assertion calls; each create answers the next of ``codes``."""

    def __init__(self, cf, codes=(0, 0), release_code=0):
        self.cf = cf
        self.codes = list(codes)
        self.release_code = release_code
        self.created = []
        self.released = []
        self._next_id = 100

    def IOPMAssertionCreateWithName(self, kind, level, name, assertion):
        self.created.append((self.cf.strings[kind], level, self.cf.strings[name]))
        code = self.codes.pop(0)
        if code == 0:
            # through the ctypes pointer hold() passes, as IOKit writes it.
            self._next_id += 1
            assertion.contents.value = self._next_id
        return code

    def IOPMAssertionRelease(self, assertion):
        self.released.append(assertion)
        return self.release_code


def iopm(codes=(0, 0), release_code=0):
    cf = FakeCoreFoundation()
    iokit = FakeIOKit(cf, codes, release_code)
    return IOPMAssertion(frameworks=(iokit, cf)), iokit, cf


def test_iopm_holds_the_display_and_the_system_at_level_on():
    holder, iokit, cf = iopm()

    assert holder.hold() == [101, 102]

    assert iokit.created == [
        (b'PreventUserIdleDisplaySleep', 255, b'owlette keep screens awake'),
        (b'PreventUserIdleSystemSleep', 255, b'owlette keep screens awake'),
    ]
    assert sorted(cf.released) == sorted(cf.strings)


def test_iopm_lets_the_first_go_when_the_second_is_refused():
    holder, iokit, cf = iopm(codes=(0, IOKIT_NOT_PRIVILEGED))

    with pytest.raises(RuntimeError, match='PreventUserIdleSystemSleep: iokit 0xe00002c1'):
        holder.hold()

    assert iokit.released == [101]
    assert sorted(cf.released) == sorted(cf.strings)


def test_iopm_release_lets_each_go():
    holder, iokit, _ = iopm()

    holder.release([101, 102])

    assert iokit.released == [101, 102]


def test_iopm_reports_a_failed_release():
    holder, _, _ = iopm(release_code=IOKIT_NOT_PRIVILEGED)

    with pytest.raises(RuntimeError, match='IOPMAssertionRelease: iokit 0xe00002c1, 0xe00002c1'):
        holder.release([101, 102])


# ---------------------------------------------------------------------- linux

class FakeChild:
    """A systemd-inhibit process: ``exit_code`` None is one still holding."""

    def __init__(self, exit_code=None, stderr=b'', stubborn=False):
        self.exit_code = exit_code
        self.stderr = io.BytesIO(stderr)
        self.stubborn = stubborn
        self.ops = []

    def wait(self, timeout=None):
        self.ops.append('wait')
        if self.exit_code is None:
            raise subprocess.TimeoutExpired('systemd-inhibit', timeout)
        return self.exit_code

    def terminate(self):
        self.ops.append('terminate')
        if not self.stubborn:
            self.exit_code = -15

    def kill(self):
        self.ops.append('kill')
        self.exit_code = -9


class FakePopen:
    def __init__(self, child=None, error=None):
        self.child = child
        self.error = error
        self.calls = []

    def __call__(self, argv, **kwargs):
        self.calls.append((argv, kwargs))
        if self.error is not None:
            raise self.error
        return self.child


def inhibit(popen, path='/usr/bin/systemd-inhibit'):
    return SystemdInhibit(which=lambda name: path if name == 'systemd-inhibit' else None, popen=popen)


def test_inhibit_holds_with_a_child_tied_to_the_agent():
    child = FakeChild()
    popen = FakePopen(child)

    assert inhibit(popen).hold() is child

    argv, kwargs = popen.calls[0]
    assert argv == [
        '/usr/bin/systemd-inhibit', '--what=sleep:idle:handle-lid-switch', '--who=owlette',
        '--why=keep screens awake', '--mode=block', 'tail', f'--pid={os.getpid()}', '-f', '/dev/null',
    ]
    assert kwargs['stdin'] is subprocess.DEVNULL
    assert kwargs['stdout'] is subprocess.DEVNULL
    assert child.stderr.closed


def test_inhibit_absent_reports_no_inhibit():
    popen = FakePopen(FakeChild())
    keeper = KeepAwake(inhibit(popen, path=None))

    keeper.set_wanted(True)
    assert settled(keeper)

    assert popen.calls == []
    assert keeper.status() == {
        'wanted': True, 'held': False, 'how': 'systemd_inhibit', 'reason': 'no_inhibit',
    }


def test_inhibit_reports_a_refusal_with_its_last_line():
    child = FakeChild(exit_code=1, stderr=b'Failed to inhibit: Access denied\n')

    with pytest.raises(RuntimeError, match='^systemd-inhibit exited 1: Failed to inhibit: Access denied$'):
        inhibit(FakePopen(child)).hold()

    assert child.stderr.closed


def test_inhibit_reports_a_failed_spawn():
    popen = FakePopen(error=PermissionError(13, 'Permission denied'))

    with pytest.raises(RuntimeError, match='^systemd-inhibit: .*Permission denied'):
        inhibit(popen).hold()


def test_inhibit_release_terminates_the_child():
    child = FakeChild()

    inhibit(FakePopen(child)).release(child)

    assert child.ops == ['terminate', 'wait']


def test_inhibit_release_kills_a_child_that_will_not_stop():
    child = FakeChild(stubborn=True)

    inhibit(FakePopen(child)).release(child)

    assert child.ops == ['terminate', 'wait', 'kill', 'wait']
