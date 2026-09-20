"""Task 3.1 wiring: the swoop objects as OwletteService actually builds them.

Nothing here mocks the wiring it is testing. The swoop methods under test are
the production ones, bound onto a double that carries only the attributes
OwletteService.__init__ gives them; the streamer is a real child process over
real pipes (fake_streamer.py); the ConnectionManager is the real one.

The two properties that matter:

* a ring reaches the streamer and a service stop ends it, through the same
  method the SCM watcher funnels into (SvcStop went with the pywin32
  ServiceFramework base class -- owlette-host is the service);
* a signalling outage is not a Firestore failure. The doorbell is the one
  component allowed its own reconnection ladder, so every test here that runs
  it also asserts that ConnectionManager was never touched.

The seams (clock, waits, socket factory, HTTP client) are injected by
subclassing SwoopDoorbell, so the service still constructs it exactly as it
does in production and the constructor call itself is an assertion.
"""

import inspect
import json
import random
import subprocess
import sys
import threading
import time
from pathlib import Path

import pytest
import win32event

import owlette_service
import swoop_commands
import swoop_doorbell as sd
import swoop_manager
import swoop_spawn
from command_router import CommandRouter
from connection_manager import ConnectionManager, ConnectionState
from owlette_service import OwletteService

FAKE_STREAMER = Path(__file__).resolve().parent / 'fake_streamer.py'

TOKEN = 'doorbell-token-INTEGRATION-nevereverlogged-8841'
SIGNAL_URL = 'wss://swoop-signal.example/v1/room/site-1/machine-1'
EXPIRES_IN = 43200
BUNDLE_SENTINEL = 'BUNDLESENTINEL-INTEGRATION'


def wait_for(predicate, timeout=10.0):
    """Poll `predicate`; the doorbell, the manager and the streamer are all
    on their own threads or processes."""
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if predicate():
            return True
        time.sleep(0.01)
    return False


@pytest.fixture(autouse=True)
def shutdown_intents(monkeypatch):
    """graceful_shutdown stamps a durable shutdown intent; a test run must not
    write one onto the machine it runs on."""
    intents = []
    monkeypatch.setattr(
        owlette_service.session_state, 'set_intent_if_none', intents.append)
    return intents


# ─── doubles ──────────────────────────────────────────────────────────────


class Clock:
    def __init__(self, start=10000.0):
        self.now = start

    def monotonic(self):
        return self.now


class Waiter:
    """Stands in for every Event.wait in the doorbell's state machine."""

    def __init__(self, clock):
        self.clock = clock
        self.waits = []
        self.hooks = []

    def __call__(self, timeout):
        self.waits.append(timeout)
        self.clock.now += max(0.0, timeout)
        for hook in list(self.hooks):
            hook(self.clock.now)


class FakeSocket:
    """Stands in for websocket.WebSocketApp."""

    def __init__(self, handlers):
        self.on_open, self.on_message, self.on_close, self.on_error = handlers
        self.closed = False
        self._release = threading.Event()

    def run_forever(self, **kwargs):
        self.on_open(self)
        self._release.wait(30)
        self.on_close(self, None, None)

    def close(self):
        self.closed = True
        self._release.set()

    def deliver(self, raw):
        self.on_message(self, raw)


class OpeningFactory:
    def __init__(self):
        self.sockets = []

    def __call__(self, url, token, on_open, on_message, on_close, on_error):
        sock = FakeSocket((on_open, on_message, on_close, on_error))
        self.sockets.append(sock)
        return sock


class RefusingFactory:
    """The signalling origin is unreachable, every time."""

    def __init__(self):
        self.calls = 0

    def __call__(self, url, token, on_open, on_message, on_close, on_error):
        self.calls += 1
        raise ConnectionRefusedError('signal origin unreachable')


class MintResponse:
    status_code = 200

    def json(self):
        return {'token': TOKEN, 'kid': 'k1', 'expiresIn': EXPIRES_IN,
                'signalUrl': SIGNAL_URL}


def mint_ok(url, **kwargs):
    return MintResponse()


class FakeAuthManager:
    def get_valid_token(self):
        return 'agent-token-INTEGRATION'


class FakeFirebaseClient:
    """The surface the swoop wiring is allowed to use, over a real
    ConnectionManager."""

    def __init__(self, connection_manager):
        self.auth_manager = FakeAuthManager()
        self.connection_manager = connection_manager
        self.site_id = 'site-1'
        self.machine_id = 'machine-1'
        self.events = []
        self.stopped = False

    def is_connected(self):
        return self.connection_manager.is_connected

    def log_event(self, action, level, details=None, **kwargs):
        self.events.append((action, level, details))

    def enter_shutdown_mode(self):
        pass

    def stop(self):
        self.stopped = True


def watched_connection_manager():
    """A real, CONNECTED ConnectionManager whose supervision entry points
    record instead of acting. Nothing swoop does may reach them."""
    cm = ConnectionManager()
    cm.report_success()  # CONNECTED without a network call
    calls = []

    def trap(name):
        def _trap(*args, **kwargs):
            calls.append(name)
        return _trap

    for name in ('register_thread', 'report_error', 'force_reconnect'):
        setattr(cm, name, trap(name))
    return cm, calls


class StreamerProcess:
    """The SwoopProcess surface, over an ordinary subprocess pipe pair."""

    def __init__(self, popen):
        self._p = popen
        self.pid = popen.pid
        self.exit_code = None

    def write_bundle(self, buf):
        buf.extend(b'\n')
        self._p.stdin.write(bytes(buf))
        self._p.stdin.flush()
        buf[:] = b'\x00' * len(buf)

    def write_line(self, obj):
        self._p.stdin.write((json.dumps(obj) + '\n').encode('utf-8'))
        self._p.stdin.flush()

    def iter_lines(self):
        for raw in self._p.stdout:
            line = raw.decode('utf-8', 'replace').strip()
            if line:
                yield line

    def wait(self, timeout):
        try:
            self.exit_code = self._p.wait(timeout)
        except subprocess.TimeoutExpired:
            return None
        return self.exit_code

    def close(self):
        if self._p.poll() is None:
            self._p.kill()
        for stream in (self._p.stdin, self._p.stdout):
            try:
                stream.close()
            except Exception:
                pass

    def is_running(self):
        return self._p.poll() is None


class FakeStreamerBackend:
    """swoop_spawn stand-in that really launches fake_streamer.py.

    Only the three calls the manager makes are replaced; the refusal reasons,
    exit codes and error class it also reads off the module stay real.
    """

    def __init__(self):
        self.procs = []
        self.bundles = 0

    def __getattr__(self, name):
        return getattr(swoop_spawn, name)

    def verify_install(self):
        return str(FAKE_STREAMER)

    def fetch_bundle(self, sid, site_id, machine_id, auth_manager):
        self.bundles += 1
        return bytearray(
            json.dumps({'sid': sid, 'sessionKey': BUNDLE_SENTINEL}).encode())

    def spawn(self, exe_path, log_dir=None):
        popen = subprocess.Popen(
            [sys.executable, exe_path, 'run'],
            stdin=subprocess.PIPE, stdout=subprocess.PIPE,
        )
        proc = StreamerProcess(popen)
        self.procs.append(proc)
        return proc


class RecordingManager:
    """A SwoopManager stand-in for the handler-dispatch tests."""

    def __init__(self):
        self.calls = []

    def ensure_streamer(self, sid):
        self.calls.append(('ensure_streamer', sid))

    def kill(self, reason='kill'):
        self.calls.append(('kill', reason))

    def on_session_change(self):
        self.calls.append(('on_session_change', None))


class ServiceDouble:
    """OwletteService's swoop-facing slice, with the REAL method bodies bound.

    The attributes mirror what OwletteService.__init__ gives these methods. The
    router registration is repeated here because __init__ cannot be run in a
    test (it reads config and builds a Firebase client); that __init__ performs
    it is asserted separately, in test_init_registers_the_swoop_handlers.
    """

    COMMAND_RATE_LIMIT_SECONDS = OwletteService.COMMAND_RATE_LIMIT_SECONDS

    _BOUND = ('_start_swoop', '_stop_swoop', '_check_console_session',
              'handle_firebase_command', 'graceful_shutdown')

    def __init__(self, firebase_client=None):
        self.firebase_client = firebase_client
        self.swoop_manager = None
        self.swoop_doorbell = None
        self._swoop_shutdown = threading.Event()
        self._last_console_session_id = None
        self._swoop_session_thread = None

        self._shutdown_lock = threading.Lock()
        self._shutdown_trigger = None
        self._scm_stop_requested = False
        self.is_alive = True
        self.cortex_pid = None
        self.hWaitStop = win32event.CreateEvent(None, 0, 0, None)
        self.status_writes = []

        self._command_rate_limits = {}
        self._command_router = CommandRouter()
        swoop_commands.register_handlers(self._command_router)

        for name in self._BOUND:
            setattr(self, name,
                    getattr(OwletteService, name).__get__(self, OwletteService))

    def _write_service_status(self, running=True):
        self.status_writes.append(running)


def seam_doorbell(monkeypatch, **seams):
    """Make _start_swoop build a doorbell with test seams.

    Returns (constructor kwargs the service passed, refresh_now call log).
    """
    built = []
    refreshes = []
    real = sd.SwoopDoorbell

    class Seamed(real):
        def __init__(self, **kwargs):
            built.append(dict(kwargs))
            super().__init__(**dict(seams, **kwargs))

        def refresh_now(self):
            refreshes.append(time.monotonic())
            super().refresh_now()

    monkeypatch.setattr(sd, 'SwoopDoorbell', Seamed)
    return built, refreshes


@pytest.fixture
def wired(monkeypatch):
    """A service with swoop started: a connected doorbell over a fake socket,
    and a manager that spawns the fake streamer."""
    cm, cm_calls = watched_connection_manager()
    client = FakeFirebaseClient(cm)
    backend = FakeStreamerBackend()
    monkeypatch.setattr(swoop_manager, 'swoop_spawn', backend)

    factory = OpeningFactory()
    built, refreshes = seam_doorbell(
        monkeypatch, socket_factory=factory, http_post=mint_ok)

    svc = ServiceDouble(client)
    svc._start_swoop()
    assert wait_for(lambda: svc.swoop_doorbell.is_connected()), 'doorbell never connected'

    yield {'svc': svc, 'cm': cm, 'cm_calls': cm_calls, 'backend': backend,
           'factory': factory, 'built': built, 'refreshes': refreshes,
           'client': client}

    svc._swoop_shutdown.set()
    for sock in factory.sockets:
        sock.close()
    for proc in backend.procs:
        proc.close()


# ─── tests ────────────────────────────────────────────────────────────────


def test_the_service_hands_the_doorbell_the_four_things_it_needs(wired):
    kwargs = wired['built'][0]

    assert callable(kwargs['on_ring'])
    # The agent's own token getter, not a wrapper: the doorbell mints with it.
    assert kwargs['get_agent_token'] == wired['client'].auth_manager.get_valid_token
    # The service's event, so graceful_shutdown can end the doorbell.
    assert kwargs['shutdown_event'] is wired['svc']._swoop_shutdown
    # Spike 0.6 section 7.2: the Firestore link gates dialling, and it arrives
    # as an injected callable so the doorbell never imports connection_manager.
    assert kwargs['is_connected'] == wired['client'].is_connected
    assert kwargs['is_connected']() is True


def test_a_ring_spawns_the_streamer_and_a_service_stop_kills_it(wired):
    svc = wired['svc']
    backend = wired['backend']

    wired['factory'].sockets[0].deliver(json.dumps({'type': 'ring', 'sid': 'sid-1'}))

    assert wait_for(lambda: backend.procs), 'the ring never reached ensure_streamer'
    proc = backend.procs[0]
    assert wait_for(lambda: svc.swoop_manager.status()['state'] == 'running')
    assert proc.is_running()
    assert backend.bundles == 1

    svc.graceful_shutdown('svc_stop')

    assert wait_for(lambda: not proc.is_running()), 'the streamer outlived the service'
    assert svc._swoop_shutdown.is_set()
    assert wait_for(lambda: svc.swoop_doorbell.state == sd.STATE_STOPPED)


def test_a_ring_and_a_stop_never_touch_connection_manager(wired):
    svc = wired['svc']

    wired['factory'].sockets[0].deliver(json.dumps({'type': 'ring', 'sid': 'sid-2'}))
    assert wait_for(lambda: wired['backend'].procs)
    svc.graceful_shutdown('svc_stop')
    assert wait_for(lambda: not wired['backend'].procs[0].is_running())

    # The doorbell is self-supervised: no supervised thread, no reported error.
    assert wired['cm_calls'] == []
    assert wired['cm'].state is ConnectionState.CONNECTED


def test_a_ten_minute_signalling_outage_leaves_firestore_connected(monkeypatch):
    cm, cm_calls = watched_connection_manager()
    client = FakeFirebaseClient(cm)
    clock = Clock()
    waiter = Waiter(clock)
    factory = RefusingFactory()
    seam_doorbell(monkeypatch, socket_factory=factory, http_post=mint_ok,
                  monotonic=clock.monotonic, wait=waiter,
                  rng=random.Random(7))

    svc = ServiceDouble(client)
    start = clock.now
    # Ten simulated minutes of a dead origin, then the shutdown the service
    # would set. The clock is injected, so this costs no real time.
    waiter.hooks.append(
        lambda now: svc._swoop_shutdown.set() if now - start >= 600 else None)
    svc._start_swoop()

    assert wait_for(lambda: svc.swoop_doorbell.state == sd.STATE_STOPPED)

    assert cm_calls == [], f'the doorbell reached ConnectionManager: {cm_calls}'
    assert cm.state is ConnectionState.CONNECTED
    assert client.is_connected() is True
    # The ladder has to be live in that window: neither a spin nor a stall.
    assert 6 <= factory.calls <= 12, f'{factory.calls} dials in ten minutes'


def test_swoop_commands_reach_the_manager_through_the_router():
    svc = ServiceDouble()
    manager = RecordingManager()
    svc.swoop_manager = manager
    envelope = {'siteId': 'site-1', 'machineId': 'machine-1'}

    assert svc._command_router.has_handler('swoop_session_requested')
    results = [
        svc.handle_firebase_command(
            'c1', dict(envelope, type='swoop_session_requested', sid='sid-1')),
        svc.handle_firebase_command('c2', dict(envelope, type='swoop_kill')),
        svc.handle_firebase_command('c3', dict(envelope, type='swoop_refresh')),
    ]

    assert manager.calls == [
        ('ensure_streamer', 'sid-1'),
        ('kill', 'swoop_kill any'),
        ('on_session_change', None),
    ]
    assert not any(r.startswith('Error:') for r in results), results


def test_init_registers_the_swoop_handlers():
    # The functional half is above; this is the half that proves the production
    # __init__ does the registration, in the same non-fatal shape as the roost,
    # machine and process handlers.
    # __init__ went into _init_state() in tri-platform wave 1; the
    # registration moved with it.
    source = inspect.getsource(OwletteService._init_state)
    assert 'from swoop_commands import register_handlers' in source
    assert '_register_swoop_handlers(self._command_router)' in source
    assert 'Failed to register swoop handlers' in source


def test_two_session_requests_inside_five_seconds_are_both_dispatched():
    # The per-type throttle keys on the type plus a process id, and a swoop
    # command has no process id -- so without the exemption a second viewer's
    # session request inside five seconds is refused AND recorded as failed.
    svc = ServiceDouble()
    manager = RecordingManager()
    svc.swoop_manager = manager
    envelope = {'siteId': 'site-1', 'machineId': 'machine-1'}

    first = svc.handle_firebase_command(
        'c1', dict(envelope, type='swoop_session_requested', sid='sid-1'))
    second = svc.handle_firebase_command(
        'c2', dict(envelope, type='swoop_session_requested', sid='sid-2'))

    assert 'rate limited' not in first
    assert 'rate limited' not in second
    assert manager.calls == [
        ('ensure_streamer', 'sid-1'), ('ensure_streamer', 'sid-2')]


def test_a_second_kill_inside_five_seconds_still_reaches_the_manager():
    # The revocation kill that lands right behind an operator kill is the case
    # that has to survive the throttle.
    svc = ServiceDouble()
    manager = RecordingManager()
    svc.swoop_manager = manager
    envelope = {'siteId': 'site-1', 'machineId': 'machine-1'}

    svc.handle_firebase_command('c1', dict(envelope, type='swoop_kill'))
    second = svc.handle_firebase_command('c2', dict(envelope, type='swoop_kill'))

    assert 'rate limited' not in second
    assert len(manager.calls) == 2


def test_swoop_refresh_reaches_the_doorbell(wired):
    svc = wired['svc']

    result = svc.handle_firebase_command(
        'c1', {'type': 'swoop_refresh', 'siteId': 'site-1', 'machineId': 'machine-1'})

    # The only route from the command to the doorbell is the manager's
    # on_refresh, which _start_swoop wires to refresh_now (spike 0.6 s7.1).
    assert wired['refreshes'], 'swoop_refresh never reached the doorbell'
    assert not result.startswith('Error:')


def test_the_console_session_check_reports_changes_not_the_first_read(monkeypatch):
    svc = ServiceDouble()
    manager = RecordingManager()
    svc.swoop_manager = manager
    sessions = [1, 1, 2]
    import win32ts
    monkeypatch.setattr(win32ts, 'WTSGetActiveConsoleSessionId',
                        lambda: sessions.pop(0))

    svc._check_console_session()  # baseline
    svc._check_console_session()  # unchanged
    svc._check_console_session()  # changed

    assert wait_for(lambda: manager.calls == [('on_session_change', None)]), manager.calls


def test_the_console_session_check_does_nothing_before_swoop_starts(monkeypatch):
    # It runs on the 5s tick from the first iteration, before _start_swoop on a
    # machine with Firebase disabled -- and must not read win32ts at all.
    svc = ServiceDouble()
    reads = []
    import win32ts
    monkeypatch.setattr(win32ts, 'WTSGetActiveConsoleSessionId',
                        lambda: reads.append(1))

    svc._check_console_session()

    assert reads == []


def test_stopping_swoop_is_safe_when_it_never_started():
    # graceful_shutdown calls this on every stop, including one where Firebase
    # is disabled and no doorbell or manager was ever built.
    svc = ServiceDouble()

    svc._stop_swoop()

    assert svc._swoop_shutdown.is_set()
