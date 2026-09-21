"""Shutdown, presence flush and desktop-app lifetime.

Covers the three agent-side halves of the 2026-08-13 14:17 incident:

* the desktop app was a child of the service, so NSSM's process-tree kill took
  the operator's UI down with the service (`build_detached_launch_command`);
* NSSM's console Control-C never arrived, so nothing flushed `online: false` and
  nothing was logged (`graceful_shutdown` + the SCM stop watcher);
* the tray's connection badge lagged the real connection by ~25s because only
  the main loop rewrote the status file (`_wire_connection_status_listener`).

Both NSSM behaviours are gone in 3.0.0 — owlette-host terminates only the process
it launched and signals a stop by reporting STOP_PENDING, exactly what the watcher
polls for. These assertions still hold the agent side of that contract: they stop
a future change from going back to relying on a signal that may never arrive.
"""

import json
import os
import threading
import time

import pytest

import owlette_service
import shared_utils


@pytest.fixture(autouse=True)
def shutdown_intents(monkeypatch):
    """Capture graceful_shutdown's durable intent write instead of performing it.

    session_state writes to %PROGRAMDATA%\\Owlette\\tmp\\session_state.json — a
    test run must not stamp a shutdown intent onto the machine it runs on, where
    the startup classifier would later read it as a real clean stop.
    """
    intents = []
    monkeypatch.setattr(
        owlette_service.session_state, 'set_intent_if_none', intents.append)
    return intents


# the desktop app must not be in the service's process tree

class TestDetachedLaunchCommand:
    def test_hands_off_through_cmd_so_the_parent_link_dies(self):
        command = shared_utils.build_detached_launch_command(
            r'C:\ProgramData\Owlette\app\owlette-desktop.exe', ('--tray',))

        # `cmd /c start` is the whole point: cmd exits immediately, so by the time
        # anything walks the tree the app has no live parent to be found from.
        assert command.startswith('cmd.exe /c start ""')
        assert r'"C:\ProgramData\Owlette\app\owlette-desktop.exe"' in command
        assert command.endswith('"--tray"')

    def test_the_empty_title_comes_before_the_path(self):
        # Without it, `start` takes the quoted path for the window title and
        # opens a console instead of the app.
        command = shared_utils.build_detached_launch_command(r'C:\a b\app.exe')
        assert command == 'cmd.exe /c start "" "C:\\a b\\app.exe"'

    def test_a_spaced_path_stays_one_argument(self):
        command = shared_utils.build_detached_launch_command(
            r'C:\Program Files\Owlette\owlette-desktop.exe', ('--restart-prompt',))
        assert '"C:\\Program Files\\Owlette\\owlette-desktop.exe"' in command

    def test_every_argument_is_quoted_separately(self):
        command = shared_utils.build_detached_launch_command(
            r'C:\app.exe', ('--tray', '--other value'))
        assert command == 'cmd.exe /c start "" "C:\\app.exe" "--tray" "--other value"'

    def test_no_arguments_leaves_no_trailing_space(self):
        assert shared_utils.build_detached_launch_command(r'C:\app.exe') == (
            'cmd.exe /c start "" "C:\\app.exe"')


def test_the_service_no_longer_kills_the_desktop_app():
    # A stopped service with no UI is unrecoverable from the machine itself:
    # starting it again is a button in the desktop app's footer.
    assert not hasattr(owlette_service.OwletteService, 'terminate_tray_icon')


# graceful shutdown

class FakeFirebaseClient:
    """Records what a shutdown asked of the cloud client."""

    def __init__(self, fail_log=False, fail_stop=False):
        self.events = []
        self.stop_calls = []
        self.calls = []  # ordered method names — the shutdown sequence matters
        self.shutdown_timeouts = []
        self.connected = True
        self._fail_log = fail_log
        self._fail_stop = fail_stop

    def enter_shutdown_mode(self, timeout_seconds=3.0):
        self.calls.append('enter_shutdown_mode')
        self.shutdown_timeouts.append(timeout_seconds)

    def log_event(self, action, level, details=None):
        self.calls.append('log_event')
        if self._fail_log:
            raise RuntimeError('firestore unreachable')
        self.events.append(action)

    def is_connected(self):
        return self.connected

    def stop(self, intentional=False):
        self.calls.append('stop')
        if self._fail_stop:
            raise RuntimeError('teardown blew up')
        self.stop_calls.append(intentional)


def _write_sentinel(path, age_seconds=0, control='stop'):
    """Write a stop sentinel, offsetting its mtime by `age_seconds`.

    Positive ages back-date it (a survivor of the previous session); negative
    ages post-date it (written after this process started). Explicit stamping
    rather than sleeping: the freshness comparison is against a time.time()
    reference whose granularity on Windows (~15.6ms) is too coarse to separate
    two real writes reliably, which makes an unstamped "now" ambiguous.
    """
    stamp = time.time() - age_seconds
    with open(path, 'w') as f:
        json.dump({'control': control, 'written_at_ms': int(stamp * 1000)}, f)
    os.utime(path, (stamp, stamp))


def make_service(firebase_client=None):
    """An OwletteService with only the shutdown state __init__ would set."""
    service = object.__new__(owlette_service.OwletteService)
    service._service_start_time = time.time()
    service.is_alive = True
    service.firebase_client = firebase_client
    service._shutdown_lock = threading.Lock()
    service._shutdown_trigger = None
    service._scm_query_failure_logged = False
    service._connection_status_manager = None
    service._last_status_signature = None
    service._last_status_write_time = 0.0
    service._status_writes = []
    service._write_service_status = lambda running=True: service._status_writes.append(running)
    return service


class TestGracefulShutdown:
    def test_flushes_presence_and_logs_the_stop(self):
        client = FakeFirebaseClient()
        service = make_service(client)

        assert service.graceful_shutdown('scm_stop') is True

        # `intentional=False` is the flag that actually writes `online: false`;
        # an intentional stop deliberately leaves presence alone.
        assert client.stop_calls == [False]
        assert client.events == ['agent_stopped']
        assert service.is_alive is False
        assert service._status_writes == [False]

    def test_runs_once_however_many_triggers_fire(self):
        client = FakeFirebaseClient()
        service = make_service(client)

        assert service.graceful_shutdown('console_sigint') is True
        assert service.graceful_shutdown('scm_stop') is False
        assert service.graceful_shutdown('svc_stop') is False

        # The two triggers exist to cover each other, not to double up: one
        # agent_stopped event, one offline write.
        assert client.events == ['agent_stopped']
        assert client.stop_calls == [False]
        assert service._shutdown_trigger == 'console_sigint'

    def test_concurrent_triggers_still_shut_down_exactly_once(self):
        # The console handler runs on a thread Windows injects while the SCM
        # watcher is on its own — they really can arrive together.
        client = FakeFirebaseClient()
        service = make_service(client)
        results = []
        start = threading.Event()

        def trigger(name):
            start.wait()
            results.append(service.graceful_shutdown(name))

        threads = [
            threading.Thread(target=trigger, args=(f'trigger_{i}',))
            for i in range(8)
        ]
        for thread in threads:
            thread.start()
        start.set()
        for thread in threads:
            thread.join(timeout=5)

        assert sorted(results) == [False] * 7 + [True]
        assert client.events == ['agent_stopped']
        assert client.stop_calls == [False]

    def test_a_failed_event_log_still_flushes_presence(self):
        # Losing the audit line is survivable; leaving the machine reading
        # online forever is what put a stale machine on the dashboard.
        client = FakeFirebaseClient(fail_log=True)
        service = make_service(client)

        assert service.graceful_shutdown('scm_stop') is True
        assert client.stop_calls == [False]

    def test_a_failed_teardown_still_writes_the_final_status(self):
        client = FakeFirebaseClient(fail_stop=True)
        service = make_service(client)

        assert service.graceful_shutdown('scm_stop') is True
        assert service._status_writes == [False]

    def test_survives_having_no_cloud_client(self):
        service = make_service(None)

        assert service.graceful_shutdown('scm_stop') is True
        assert service.is_alive is False
        assert service._status_writes == [False]

    def test_records_the_clean_stop_even_when_every_cloud_call_fails(self, shutdown_intents):
        # The intent write is what stops the next boot reporting an
        # unexpected_reboot. It used to sit behind a Firestore log_event whose
        # REST calls could outlast the ~5s Windows allows at OS shutdown.
        client = FakeFirebaseClient(fail_log=True, fail_stop=True)
        service = make_service(client)

        assert service.graceful_shutdown('scm_stop') is True
        assert shutdown_intents == ['external_clean']

    def test_records_the_clean_stop_without_a_cloud_client(self, shutdown_intents):
        # A disconnected agent stopped cleanly is still a clean stop; the write
        # used to be gated on having a Firebase client at all.
        service = make_service(None)

        assert service.graceful_shutdown('scm_stop') is True
        assert shutdown_intents == ['external_clean']

    def test_caps_the_firestore_timeout_before_talking_to_the_cloud(self):
        # 30s per request outlives the shutdown window; whatever is attempted
        # after this point has to fit inside it.
        client = FakeFirebaseClient()
        service = make_service(client)

        service.graceful_shutdown('scm_stop')

        assert client.calls[:2] == ['enter_shutdown_mode', 'log_event']


# the SCM stop watcher

class TestScmStopWatcher:
    @pytest.fixture(autouse=True)
    def sentinel_path(self, tmp_path, monkeypatch):
        """Point the stop sentinel at a temp file, never the live install."""
        path = str(tmp_path / 'stop_signal.json')
        monkeypatch.setattr(owlette_service, 'STOP_SENTINEL_PATH', path)
        # the runner, not system, owns these files; the owner gate is pinned
        # in test_owlette_service_hardening.py.
        monkeypatch.setattr(owlette_service.acl_hardening, 'is_trusted_owner', lambda *a: True)
        return path

    def test_reads_the_live_service_without_elevation(self):
        # The watcher runs as LocalSystem in production, but SERVICE_QUERY_STATUS
        # is readable unelevated — if this ever needs rights the agent does not
        # have, the watcher silently never fires.
        service = object.__new__(owlette_service.OwletteService)
        assert service._query_scm_stop_requested() in (True, False)

    def test_fires_graceful_shutdown_when_the_scm_reports_stopping(self, monkeypatch):
        client = FakeFirebaseClient()
        service = make_service(client)
        monkeypatch.setattr(owlette_service, 'SCM_STOP_POLL_INTERVAL', 0.01)

        polls = []

        def fake_query(_self=None):
            polls.append(1)
            return len(polls) >= 3

        service._query_scm_stop_requested = fake_query
        thread = service.start_scm_stop_watcher()
        thread.join(timeout=5)

        assert not thread.is_alive()
        assert service._shutdown_trigger == 'scm_stop'
        assert client.stop_calls == [False]

    def test_does_not_fire_while_the_service_is_running(self, monkeypatch):
        client = FakeFirebaseClient()
        service = make_service(client)
        monkeypatch.setattr(owlette_service, 'SCM_STOP_POLL_INTERVAL', 0.01)

        service._query_scm_stop_requested = lambda: False
        thread = service.start_scm_stop_watcher()
        time.sleep(0.1)
        service.is_alive = False
        thread.join(timeout=5)

        assert service._shutdown_trigger is None
        assert client.stop_calls == []

    def test_gives_up_rather_than_spinning_when_the_scm_cannot_be_read(self, monkeypatch):
        service = make_service(FakeFirebaseClient())
        monkeypatch.setattr(owlette_service, 'SCM_STOP_POLL_INTERVAL', 0.001)

        attempts = []

        def always_raises():
            attempts.append(1)
            raise OSError('the SCM is not reachable')

        service._query_scm_stop_requested = always_raises
        thread = service.start_scm_stop_watcher()
        thread.join(timeout=5)

        assert not thread.is_alive()
        assert len(attempts) == 10
        # Giving up is not the same as deciding the service is stopping.
        assert service._shutdown_trigger is None

    def test_the_host_sentinel_fires_a_shutdown_when_the_scm_is_unreadable(
            self, sentinel_path, monkeypatch):
        # The whole point of the sentinel: owlette-host saw the control even
        # though the SCM query is answering "not stopping".
        client = FakeFirebaseClient()
        service = make_service(client)
        monkeypatch.setattr(owlette_service, 'SCM_STOP_POLL_INTERVAL', 0.01)
        service._query_scm_stop_requested = lambda: False

        thread = service.start_scm_stop_watcher()
        # After the watcher starts: starting it clears a stale sentinel first.
        _write_sentinel(sentinel_path, age_seconds=-1, control='preshutdown')
        thread.join(timeout=5)

        assert not thread.is_alive()
        assert service._shutdown_trigger == 'scm_stop'
        assert client.stop_calls == [False]

    def test_an_unreadable_sentinel_still_counts_as_a_stop(self, sentinel_path):
        # Existence is the signal — a half-written body must not lose the stop.
        service = make_service(FakeFirebaseClient())
        with open(sentinel_path, 'w') as f:
            f.write('{"control": "sto')

        assert service._read_stop_sentinel(time.time() - 60) == 'unknown'

    def test_a_sentinel_older_than_this_process_is_not_a_stop(self, sentinel_path):
        # Freshness, not existence alone: a survivor belongs to the run that
        # wrote it.
        service = make_service(FakeFirebaseClient())
        _write_sentinel(sentinel_path, age_seconds=60)

        assert service._read_stop_sentinel(service._service_start_time) is None

    def test_a_stale_sentinel_is_cleared_before_the_watcher_starts(self, sentinel_path):
        # A survivor from the previous stop would shut this run down immediately.
        service = make_service(FakeFirebaseClient())
        service.is_alive = False  # let the watcher thread exit on its first check
        _write_sentinel(sentinel_path, age_seconds=60)

        thread = service.start_scm_stop_watcher()
        thread.join(timeout=5)

        assert not os.path.exists(sentinel_path)
        assert service._shutdown_trigger is None

    def test_an_undeletable_stale_sentinel_does_not_stop_the_service(
            self, sentinel_path, monkeypatch):
        # An AV lock or a bad ACL used to mean the watcher obeyed a survivor
        # 250ms after every start — the host relaunches, and that is a restart
        # storm. Ignoring it as stale is what makes the delete best-effort.
        client = FakeFirebaseClient()
        service = make_service(client)
        monkeypatch.setattr(owlette_service, 'SCM_STOP_POLL_INTERVAL', 0.01)
        service._query_scm_stop_requested = lambda: False
        _write_sentinel(sentinel_path, age_seconds=60)

        def refuse(_path):
            raise OSError('locked by another process')

        monkeypatch.setattr(owlette_service.os, 'remove', refuse)

        thread = service.start_scm_stop_watcher()
        time.sleep(0.1)
        service.is_alive = False
        thread.join(timeout=5)

        assert os.path.exists(sentinel_path)  # still there — the delete failed
        assert service._shutdown_trigger is None
        assert client.stop_calls == []

    def test_a_sentinel_written_during_startup_survives_the_stale_clear(
            self, sentinel_path, monkeypatch):
        # The host can accept a stop while python is still starting; that
        # sentinel is real and must not be swept away by the stale-clear.
        client = FakeFirebaseClient()
        service = make_service(client)
        monkeypatch.setattr(owlette_service, 'SCM_STOP_POLL_INTERVAL', 0.01)
        service._query_scm_stop_requested = lambda: False
        # Written after _service_start_time, i.e. during startup.
        _write_sentinel(sentinel_path, age_seconds=-1)

        thread = service.start_scm_stop_watcher()
        thread.join(timeout=5)

        assert os.path.exists(sentinel_path)
        assert service._shutdown_trigger == 'scm_stop'
        assert client.stop_calls == [False]

    def test_the_corroboration_window_is_anchored_on_the_last_heartbeat(self, monkeypatch):
        # The other half of a missed stop: when the agent captured no signal,
        # the Windows event log is asked whether the shutdown was orderly. The
        # search window must hug the last heartbeat — anchoring its far edge on
        # boot time would let an unrelated clean reboot hours later vouch for a
        # crash and hide the outage in between.
        service = object.__new__(owlette_service.OwletteService)
        last_alive = 1_700_000_000
        boot = last_alive + 7200  # the machine came back two hours later

        monkeypatch.setattr(owlette_service.session_state, 'read_state', lambda: {
            'schema': owlette_service.session_state.SCHEMA_VERSION,
            'boot_time': last_alive - 3600,
            'last_alive': last_alive,
            'version': shared_utils.APP_VERSION,
            'shutdown_intent': None,
        })
        monkeypatch.setattr(
            owlette_service.session_state, 'init_session', lambda **_kw: True)
        monkeypatch.setattr(owlette_service.psutil, 'boot_time', lambda: boot)

        captured = {}

        def fake_query(start, end):
            captured['start'], captured['end'] = start, end
            return False

        service._clean_shutdown_in_event_log = fake_query
        service._classify_startup_session()

        assert captured['start'] == last_alive - owlette_service.SHUTDOWN_EVIDENCE_LEAD_SECONDS
        assert captured['end'] == last_alive + owlette_service.SHUTDOWN_EVIDENCE_TRAIL_SECONDS
        assert captured['end'] < boot
        assert service._pending_anomaly_event[0] == 'unexpected_reboot'

    def test_the_poll_interval_fits_inside_the_hosts_kill_budget(self):
        # owlette-host terminates the agent CHILD_STOP_GRACE (20s) after the
        # stop control; NSSM did it at ~4.5s. A poll slower than the budget
        # would notice the stop only after the process was already gone.
        assert owlette_service.SCM_STOP_POLL_INTERVAL < owlette_service.SCM_STOP_GRACE_SECONDS
        assert owlette_service.SCM_STOP_POLL_INTERVAL <= 0.5


# the tray's connection badge

class FakeConnectionManager:
    def __init__(self):
        self.listeners = []

    def add_state_listener(self, listener):
        self.listeners.append(listener)


class TestConnectionStatusListener:
    def test_publishes_the_state_the_client_already_reached(self):
        # CONNECTING -> CONNECTED happens inside FirebaseClient.__init__, before
        # anything is listening; without this write the tray shows a red badge
        # until the first main-loop status write.
        service = make_service(FakeFirebaseClient())
        service.firebase_client.connection_manager = FakeConnectionManager()

        service._wire_connection_status_listener()

        assert service._status_writes == [True]
        assert len(service.firebase_client.connection_manager.listeners) == 1

    def test_every_later_transition_rewrites_the_file(self):
        service = make_service(FakeFirebaseClient())
        manager = FakeConnectionManager()
        service.firebase_client.connection_manager = manager

        service._wire_connection_status_listener()
        service._status_writes.clear()

        # A disconnect has to turn the badge red as fast as a connect turns it
        # green — the listener is not connect-only.
        manager.listeners[0](object())
        manager.listeners[0](object())

        assert service._status_writes == [True, True]

    def test_registering_twice_does_not_stack_listeners(self):
        service = make_service(FakeFirebaseClient())
        manager = FakeConnectionManager()
        service.firebase_client.connection_manager = manager

        service._wire_connection_status_listener()
        service._wire_connection_status_listener()

        assert len(manager.listeners) == 1
        # ...but the state is republished each time, which is what makes the
        # call safe to repeat from the runner, main() and a Firebase re-init.
        assert service._status_writes == [True, True]

    def test_a_replaced_client_gets_its_own_listener(self):
        service = make_service(FakeFirebaseClient())
        first = FakeConnectionManager()
        service.firebase_client.connection_manager = first
        service._wire_connection_status_listener()

        # _initialize_firebase_client builds a whole new client; the listener
        # has to follow it or the badge freezes on the old one's last state.
        service.firebase_client = FakeFirebaseClient()
        second = FakeConnectionManager()
        service.firebase_client.connection_manager = second
        service._wire_connection_status_listener()

        assert len(first.listeners) == 1
        assert len(second.listeners) == 1

    def test_does_nothing_without_a_cloud_client(self):
        service = make_service(None)
        service._wire_connection_status_listener()
        assert service._status_writes == []


@pytest.mark.parametrize('attribute', [
    '_shutdown_lock',
    '_shutdown_trigger',
    '_connection_status_manager',
])
def test_mockservice_mirrors_every_new_attribute(attribute):
    """owlette_runner.MockService must carry everything OwletteService.__init__
    sets, or the hosted path raises AttributeError in production."""
    import pathlib
    source = pathlib.Path(owlette_service.__file__).with_name('owlette_runner.py')
    assert f'self.{attribute}' in source.read_text(encoding='utf-8'), (
        f'{attribute} is missing from MockService.__init__'
    )
