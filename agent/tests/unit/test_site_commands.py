"""
Unit tests for site_commands — the `site_settings_refresh` handler.

The type rides the fast command lane, so the handler must return before the
network round trip does: the fetch runs on a daemon thread, one at a time, and
requests that land during a fetch coalesce into exactly one more pass. The fake
client's fetch blocks on a gate, which is what lets these tests see a fetch in
flight. owlette_service and firebase_client are imported inside the tests, as
elsewhere in this suite, so collection order cannot double-initialise the
cryptography bindings.
"""

import inspect
import threading
import time
from types import SimpleNamespace

import pytest

import site_commands
from command_router import CommandRouter
from site_commands import handle_site_settings_refresh, register_handlers

CMD = {'type': 'site_settings_refresh', 'siteId': 'site-1', 'machineId': 'machine-1'}


def wait_for(predicate, timeout=5.0):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if predicate():
            return True
        time.sleep(0.01)
    return False


def idle():
    return not site_commands._running


class GatedClient:
    """FirebaseClient's `_fetch_site_metadata`, held until the test releases it."""

    def __init__(self):
        self.calls = 0
        self.active = 0
        self.max_active = 0
        self.started = threading.Event()
        self.release = threading.Event()
        self._lock = threading.Lock()

    def _fetch_site_metadata(self):
        with self._lock:
            self.calls += 1
            self.active += 1
            self.max_active = max(self.max_active, self.active)
        self.started.set()
        self.release.wait(5)
        with self._lock:
            self.active -= 1


def refresh(client):
    return handle_site_settings_refresh(dict(CMD), 'cmd-1', SimpleNamespace(firebase_client=client))


@pytest.fixture(autouse=True)
def settled():
    """every test starts and ends with no refresh in flight."""
    assert wait_for(idle)
    yield
    assert wait_for(idle), 'a refresh thread never finished'


# registration and lanes

def test_register_handlers_registers_the_refresh():
    router = CommandRouter()
    register_handlers(router)
    assert router.registered_types() == ['site_settings_refresh']


def test_the_refresh_is_on_the_fast_lane():
    from firebase_client import FirebaseClient
    assert 'site_settings_refresh' in FirebaseClient._FAST_COMMAND_TYPES


def test_init_registers_the_site_handlers():
    from owlette_service import OwletteService
    source = inspect.getsource(OwletteService._init_state)
    assert 'from site_commands import register_handlers' in source
    assert '_register_site_handlers(self._command_router)' in source


def test_two_refreshes_inside_five_seconds_are_both_dispatched():
    # the per-type throttle keys on the type plus a process id, and this command
    # has none: without the exemption an admin's second flip inside five seconds
    # is refused and recorded as a failed command.
    from owlette_service import OwletteService
    router = CommandRouter()
    register_handlers(router)
    client = GatedClient()
    client.release.set()
    svc = SimpleNamespace(
        firebase_client=client,
        _command_rate_limits={},
        COMMAND_RATE_LIMIT_SECONDS=5,
        _command_router=router,
    )
    svc.handle_firebase_command = OwletteService.handle_firebase_command.__get__(svc, OwletteService)

    first = svc.handle_firebase_command('c1', dict(CMD))
    second = svc.handle_firebase_command('c2', dict(CMD))

    assert not first.startswith('Error:'), first
    assert not second.startswith('Error:'), second
    assert wait_for(idle)
    assert client.calls >= 1


# non-blocking and single-flight

def test_returns_while_the_fetch_is_still_running():
    client = GatedClient()

    result = refresh(client)

    assert not result.startswith('Error:')
    # the gate is still shut, so the handler cannot have waited for the fetch
    assert client.started.wait(5)
    assert client.active == 1
    client.release.set()
    assert wait_for(idle)
    assert client.calls == 1


def test_requests_during_a_fetch_coalesce_into_one_more_pass():
    client = GatedClient()
    refresh(client)
    assert client.started.wait(5)

    results = [refresh(client) for _ in range(3)]

    assert not any(r.startswith('Error:') for r in results), results
    assert client.calls == 1, 'a second fetch started beside the running one'
    client.release.set()
    assert wait_for(idle)
    # the running fetch may have read the server before the change behind the
    # later requests, so they buy one more pass — one, not three.
    assert client.calls == 2
    assert client.max_active == 1


def test_a_request_after_the_fetch_finished_starts_a_new_one():
    client = GatedClient()
    client.release.set()

    refresh(client)
    assert wait_for(idle)
    refresh(client)
    assert wait_for(idle)

    assert client.calls == 2


def test_a_raising_fetch_does_not_wedge_later_refreshes():
    class RaisingClient:
        calls = 0

        def _fetch_site_metadata(self):
            self.calls += 1
            raise RuntimeError('boom')

    client = RaisingClient()

    refresh(client)
    assert wait_for(idle)
    refresh(client)
    assert wait_for(idle)

    assert client.calls == 2


def test_a_failed_thread_start_is_an_error_and_clears_the_flag(monkeypatch):
    class NoThread:
        def __init__(self, *args, **kwargs):
            pass

        def start(self):
            raise RuntimeError("can't start new thread")

    monkeypatch.setattr(threading, 'Thread', NoThread)

    result = refresh(GatedClient())

    assert result.startswith('Error:')
    assert idle()


def test_a_missing_firebase_client_is_an_error_string():
    result = refresh(None)

    assert result.startswith('Error:')
    assert idle()
