"""Unit tests for SwoopManager.

The spawn backend is injected, so no streamer, no pipes and no win32 calls are
involved. The two properties that matter most here are that no public method
blocks its caller -- the service's 5-second loop calls them -- and that the
bundle never reaches a log record.
"""

import json
import threading
import time

import pytest
from unittest.mock import MagicMock

import swoop_manager
import swoop_spawn
from swoop_manager import SwoopManager


BUNDLE_SECRET = 'BUNDLESENTINEL0123'


def wait_for(predicate, timeout=3.0):
    """Poll ``predicate`` until true; the manager's work is on its own thread."""
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if predicate():
            return True
        time.sleep(0.01)
    return False


class FakeProc:
    """A streamer stand-in. ``ops`` records the order of the teardown calls."""

    def __init__(self, lines=None, exit_code=0):
        self.pid = 1234
        self.exit_code = exit_code
        self.ops = []
        self.written = []
        self.bundle_len = None
        self._lines = list(lines or [])
        self._released = threading.Event()

    def write_bundle(self, buf):
        self.bundle_len = len(buf)
        buf[:] = b'\x00' * len(buf)

    def write_line(self, obj):
        self.ops.append('write_line')
        self.written.append(obj)

    def iter_lines(self):
        for line in self._lines:
            yield line
        self._released.wait(3.0)

    def wait(self, timeout):
        self.ops.append('wait')
        return self.exit_code

    def close(self):
        self.ops.append('close')
        self._released.set()


class FakeSpawn:
    """Injected ``spawn_backend``: the three calls SwoopManager makes."""

    def __init__(self, proc=None, verify_error=None, bundle_error=None, delay=0.0,
                 post_error=None, bundle_error_after=None):
        self.proc = proc or FakeProc()
        self.verify_error = verify_error
        self.bundle_error = bundle_error
        # raise `bundle_error` only from this fetch count on: the spawn's own
        # fetch succeeds and a later refresh fails
        self.bundle_error_after = bundle_error_after
        self.delay = delay
        self.spawned = 0
        self.fetched = 0
        self.post_error = post_error
        self.posted = []
        self.post_attempts = 0

    def verify_install(self):
        if self.delay:
            time.sleep(self.delay)
        if self.verify_error:
            raise self.verify_error
        return r'C:\x\swoop\owlette-swoop.exe'

    def fetch_bundle(self, sid, site_id, machine_id, auth_manager):
        self.fetched += 1
        if self.bundle_error and (self.bundle_error_after is None
                                  or self.fetched >= self.bundle_error_after):
            raise self.bundle_error
        return bytearray(json.dumps({
            'sid': sid, 'sessionKey': BUNDLE_SECRET,
            'hostToken': f'host-token-{self.fetched}',
        }).encode())

    def spawn(self, exe_path, log_dir=None):
        self.spawned += 1
        return self.proc

    def post_host_events(self, events, site_id, machine_id, auth_manager):
        self.post_attempts += 1
        if self.post_error:
            raise self.post_error
        self.posted.append((list(events), site_id, machine_id))
        return True


@pytest.fixture
def firebase():
    client = MagicMock()
    client.site_id = 'site_1'
    client.machine_id = 'machine_1'
    return client


def make_manager(backend, firebase=None, on_refresh=None):
    return SwoopManager(
        firebase_client=firebase, on_refresh=on_refresh, spawn_backend=backend,
    )


class TestSpawnRefusals:
    """Both gates are dead ends: refuse, log, do not degrade."""

    def test_unverified_install_refuses_the_spawn(self, firebase):
        backend = FakeSpawn(verify_error=swoop_spawn.SwoopSpawnError(
            swoop_spawn.REFUSAL_INSTALL_UNVERIFIED, 'layout mismatch',
        ))
        manager = make_manager(backend, firebase)
        manager.ensure_streamer('sid_1')

        assert wait_for(lambda: manager.status()['lastRefusal'])
        assert manager.status()['lastRefusal'] == swoop_spawn.REFUSAL_INSTALL_UNVERIFIED
        assert backend.spawned == 0
        actions = [call.args[0] for call in firebase.log_event.call_args_list]
        assert 'swoop_spawn_refused' in actions

    def test_version_mismatch_refuses_the_spawn(self, firebase):
        backend = FakeSpawn(verify_error=swoop_spawn.SwoopSpawnError(
            swoop_spawn.REFUSAL_VERSION_MISMATCH, "'9.9.9' != '3.3.5'",
        ))
        manager = make_manager(backend, firebase)
        manager.ensure_streamer('sid_1')

        assert wait_for(lambda: manager.status()['lastRefusal'])
        assert manager.status()['lastRefusal'] == swoop_spawn.REFUSAL_VERSION_MISMATCH
        assert backend.spawned == 0

    def test_bundle_failure_refuses_and_leaves_no_session(self, firebase):
        backend = FakeSpawn(bundle_error=swoop_spawn.SwoopSpawnError(
            swoop_spawn.REFUSAL_BUNDLE_UNAVAILABLE, 'bundle fetch failed: 503',
        ))
        manager = make_manager(backend, firebase)
        manager.ensure_streamer('sid_1')

        assert wait_for(lambda: manager.status()['lastRefusal'])
        status = manager.status()
        assert status['state'] == swoop_manager.STATE_IDLE
        assert status['sid'] is None
        assert backend.spawned == 0

    def test_spawn_rate_ceiling_refuses_and_logs(self, firebase):
        backend = FakeSpawn()
        manager = make_manager(backend, firebase)
        now = time.monotonic()
        manager._spawn_times = [now] * swoop_manager.SPAWN_CEILING

        manager.ensure_streamer('sid_1')
        assert wait_for(lambda: manager.status()['lastRefusal'] == 'spawn_rate_ceiling')
        assert backend.spawned == 0
        details = [call.kwargs.get('details', '') for call in firebase.log_event.call_args_list]
        assert any('spawn_rate_ceiling' in d for d in details)

    def test_backoff_window_refuses(self, firebase):
        backend = FakeSpawn()
        manager = make_manager(backend, firebase)
        manager._retry_after = time.monotonic() + 60

        manager.ensure_streamer('sid_1')
        assert wait_for(lambda: manager.status()['lastRefusal'] == 'backoff')
        assert backend.spawned == 0


class TestBackoffLadder:
    """A crash climbs the ladder and the ladder caps; a clean exit clears it."""

    def test_backoff_grows_and_caps(self):
        manager = make_manager(FakeSpawn())
        seen = []
        for _ in range(12):
            manager._apply_backoff(swoop_spawn.EXIT_INTERNAL)
            seen.append(manager._backoff_s)

        assert seen[0] == swoop_manager.BACKOFF_BASE_S
        assert seen[1] == swoop_manager.BACKOFF_BASE_S * 2
        assert seen == sorted(seen)
        assert seen[-1] == swoop_manager.BACKOFF_MAX_S
        assert max(seen) <= swoop_manager.BACKOFF_MAX_S

    def test_clean_exit_clears_the_ladder(self):
        manager = make_manager(FakeSpawn())
        manager._apply_backoff(swoop_spawn.EXIT_INTERNAL)
        assert manager._backoff_s > 0
        manager._apply_backoff(swoop_spawn.EXIT_OK)
        assert manager._backoff_s == 0
        assert manager.status()['retryInS'] == 0


class TestSessionLifecycle:
    def test_start_spawns_and_logs_the_session(self, firebase):
        backend = FakeSpawn()
        manager = make_manager(backend, firebase)
        manager.ensure_streamer('sid_1')

        assert wait_for(lambda: backend.spawned == 1)
        assert wait_for(lambda: manager.status()['state'] == swoop_manager.STATE_RUNNING)
        assert manager.status()['sid'] == 'sid_1'
        actions = [call.args[0] for call in firebase.log_event.call_args_list]
        assert 'swoop_session_start' in actions
        manager.kill('test')

    def test_second_ensure_for_the_same_sid_does_not_respawn(self, firebase):
        backend = FakeSpawn()
        manager = make_manager(backend, firebase)
        manager.ensure_streamer('sid_1')
        assert wait_for(lambda: backend.spawned == 1)

        manager.ensure_streamer('sid_1')
        time.sleep(0.2)
        assert backend.spawned == 1
        manager.kill('test')

    def test_kill_writes_the_kill_line_before_closing_the_job(self, firebase):
        proc = FakeProc()
        backend = FakeSpawn(proc=proc)
        manager = make_manager(backend, firebase)
        manager.ensure_streamer('sid_1')
        assert wait_for(lambda: backend.spawned == 1)

        manager.kill('operator')
        assert wait_for(lambda: 'close' in proc.ops)
        assert proc.ops.index('write_line') < proc.ops.index('close')
        assert proc.written == [{'type': 'kill'}]
        assert wait_for(lambda: manager.status()['state'] == swoop_manager.STATE_IDLE)
        actions = [call.args[0] for call in firebase.log_event.call_args_list]
        assert 'swoop_session_end' in actions

    def test_kill_with_no_session_is_a_no_op(self, firebase):
        manager = make_manager(FakeSpawn(), firebase)
        manager.kill('operator')
        time.sleep(0.15)
        assert manager.status()['state'] == swoop_manager.STATE_IDLE

    def test_bundle_never_appears_in_a_log_record(self, firebase, caplog):
        caplog.set_level('DEBUG')
        proc = FakeProc()
        backend = FakeSpawn(proc=proc)
        manager = make_manager(backend, firebase)
        manager.ensure_streamer('sid_1')
        assert wait_for(lambda: backend.spawned == 1)
        manager.kill('test')
        assert wait_for(lambda: 'close' in proc.ops)

        assert BUNDLE_SECRET not in caplog.text
        logged = json.dumps([
            (call.args, call.kwargs) for call in firebase.log_event.call_args_list
        ])
        assert BUNDLE_SECRET not in logged
        # and the buffer handed to the streamer was wiped
        assert proc.bundle_len and proc.bundle_len > 0


class TestStdoutEvents:
    """Every event named in PROTOCOL.md section 6 is parsed and queued."""

    def test_every_event_type_is_parsed(self):
        manager = make_manager(FakeSpawn())
        lines = [
            '{"type":"ready","sid":"s","pid":9,"version":"3.3.5"}',
            '{"type":"viewer_joined","sid":"s","viewer":"v1","ctl":true}',
            '{"type":"viewer_joined","sid":"s","viewer":"v2","ctl":false}',
            '{"type":"status","sid":"s","viewers":2,"fps":60,"path":"direct"}',
            '{"type":"sas_request","sid":"s","viewer":"v1"}',
            '{"type":"host_event","sid":"s","kind":"input_not_permitted","viewer":"v2"}',
            '{"type":"viewer_left","sid":"s","viewer":"v2","reason":"bye"}',
            '{"type":"exiting","sid":"s","code":0,"reason":"idle"}',
        ]
        for line in lines:
            manager._handle_line(line)

        events = manager.drain_events()
        assert [e['type'] for e in events] == [
            'ready', 'viewer_joined', 'viewer_joined', 'status',
            'sas_request', 'host_event', 'viewer_left', 'exiting',
        ]
        status = manager.status()
        assert status['viewers'] == 1
        assert status['controllers'] == 1
        assert status['streamer']['fps'] == 60

    def test_a_host_event_reaches_the_audit_route_in_the_routes_own_shape(self, firebase):
        backend = FakeSpawn()
        manager = make_manager(backend, firebase)
        manager._handle_line(json.dumps({
            'type': 'host_event', 'sid': 'sid_1', 'kind': 'jwt_rejected',
            'viewer': 'viewer_1', 'reason': 'unknown_kid',
        }))

        assert wait_for(lambda: backend.posted)
        events, site_id, machine_id = backend.posted[0]
        assert site_id == 'site_1'
        assert machine_id == 'machine_1'
        # the streamer's `kind` is the route's `type`; `viewer` is its `viewerId`.
        assert events == [{
            'type': 'jwt_rejected', 'sid': 'sid_1',
            'viewerId': 'viewer_1', 'reason': 'unknown_kid',
        }]

    def test_a_host_event_missing_a_required_field_is_dropped_here(self, firebase):
        """The route refuses the whole batch on one bad entry."""
        backend = FakeSpawn()
        manager = make_manager(backend, firebase)
        manager._handle_line('{"type":"host_event","sid":"sid_1"}')
        manager._handle_line('{"type":"host_event","kind":"jwt_rejected"}')
        manager._handle_line(json.dumps({
            'type': 'host_event', 'sid': 'sid_1', 'kind': 'join_refused',
        }))

        assert wait_for(lambda: backend.posted)
        events, _, _ = backend.posted[0]
        assert events == [{'type': 'join_refused', 'sid': 'sid_1'}]

    def test_a_failed_post_is_not_retried_and_does_not_stop_the_drain(self, firebase):
        backend = FakeSpawn(post_error=RuntimeError('503'))
        manager = make_manager(backend, firebase)
        manager._handle_line(json.dumps({
            'type': 'host_event', 'sid': 'sid_1', 'kind': 'fp_mismatch',
        }))
        assert wait_for(lambda: backend.post_attempts == 1)
        assert backend.posted == [], 'the batch was lost, not retried'

        # and the thread is still draining, so the next event still goes.
        backend.post_error = None
        manager._handle_line(json.dumps({
            'type': 'host_event', 'sid': 'sid_1', 'kind': 'lease_expired',
        }))
        assert wait_for(lambda: any(
            event['type'] == 'lease_expired'
            for batch, _, _ in backend.posted for event in batch
        ))

    def test_the_audit_queue_is_bounded_and_keeps_the_newest(self, firebase):
        manager = make_manager(FakeSpawn(), firebase)
        # nothing drains, so the bound is the only thing holding it back.
        manager._start_auditor = lambda: None
        overflow = swoop_manager.AUDIT_QUEUE_MAX + 10
        for i in range(overflow):
            manager._queue_host_event({
                'type': 'host_event', 'sid': f'sid_{i}', 'kind': 'join_refused',
            })

        assert manager._audit.qsize() == swoop_manager.AUDIT_QUEUE_MAX
        rows = [manager._audit.get_nowait() for _ in range(swoop_manager.AUDIT_QUEUE_MAX)]
        assert rows[-1]['sid'] == f'sid_{overflow - 1}', 'the newest row survived'

    def test_malformed_and_unknown_lines_are_dropped(self):
        manager = make_manager(FakeSpawn())
        manager._handle_line('not json')
        manager._handle_line('[1,2,3]')
        manager._handle_line('{"type":"exec","cmd":"whoami"}')
        assert manager.drain_events() == []

    def test_event_queue_is_bounded(self):
        manager = make_manager(FakeSpawn())
        for i in range(swoop_manager.EVENT_QUEUE_MAX + 50):
            manager._handle_line(json.dumps({'type': 'status', 'sid': 's', 'n': i}))
        events = manager.drain_events(max_items=10_000)
        assert len(events) == swoop_manager.EVENT_QUEUE_MAX
        assert events[-1]['n'] == swoop_manager.EVENT_QUEUE_MAX + 49

    def test_reader_thread_ends_the_session_when_the_streamer_exits(self, firebase):
        proc = FakeProc(lines=['{"type":"exiting","sid":"sid_1","code":20}'], exit_code=20)
        backend = FakeSpawn(proc=proc)
        manager = make_manager(backend, firebase)
        manager.ensure_streamer('sid_1')
        assert wait_for(lambda: backend.spawned == 1)

        proc._released.set()  # the streamer closed its stdout
        assert wait_for(lambda: manager.status()['state'] == swoop_manager.STATE_IDLE)
        assert manager.status()['lastExit']['code'] == 20
        assert manager.status()['retryInS'] > 0  # a crash arms the ladder


class TestNonBlocking:
    """Nothing here may sit on the service's 5-second loop."""

    def test_every_method_returns_immediately(self, firebase):
        backend = FakeSpawn(delay=1.0)  # a slow gate must not reach the caller
        manager = make_manager(backend, firebase, on_refresh=lambda: None)

        for call in (
            lambda: manager.ensure_streamer('sid_1'),
            lambda: manager.kill('test'),
            manager.on_session_change,
            manager.status,
            manager.drain_events,
        ):
            started = time.monotonic()
            call()
            assert time.monotonic() - started < 0.2, call

    def test_work_queue_full_drops_instead_of_blocking(self, firebase):
        manager = make_manager(FakeSpawn(), firebase)
        manager._start_worker = lambda: None  # nothing drains the queue
        for _ in range(swoop_manager.WORK_QUEUE_MAX + 5):
            started = time.monotonic()
            manager.ensure_streamer('sid_1')
            assert time.monotonic() - started < 0.2


class TestRefreshCallback:
    """Spike 0.6: on_session_change is swoop_refresh's only route to the doorbell."""

    def test_on_session_change_invokes_on_refresh(self):
        calls = []
        manager = make_manager(FakeSpawn(), on_refresh=lambda: calls.append(1))
        manager.on_session_change()
        assert calls == [1]

    def test_on_session_change_without_a_callback_is_safe(self):
        make_manager(FakeSpawn()).on_session_change()

    def test_a_raising_callback_never_escapes(self):
        def boom():
            raise RuntimeError('doorbell down')

        manager = make_manager(FakeSpawn(), on_refresh=boom)
        manager.on_session_change()  # no raise


class TestSpawnCleanup:
    """A streamer that never received its bundle must not be left running."""

    def test_failed_bundle_write_closes_the_streamer(self, firebase):
        proc = FakeProc()

        def boom(_buf):
            raise OSError('broken pipe')

        proc.write_bundle = boom
        backend = FakeSpawn(proc=proc)
        manager = make_manager(backend, firebase)
        manager.ensure_streamer('sid_1')

        assert wait_for(lambda: 'close' in proc.ops)
        assert manager.status()['state'] == swoop_manager.STATE_IDLE
        assert manager.status()['lastRefusal'] == swoop_spawn.REFUSAL_SPAWN_FAILED


class TestHostTokenRefresh:
    """The host's room token lives 300 s and the streamer cannot mint one: the
    manager re-mints a minute ahead and hands it over on stdin."""

    def _fast(self, monkeypatch, ttl=2, lead=1, retry=20):
        import swoop_manager
        monkeypatch.setattr(swoop_manager, 'TOKEN_TTL_DEFAULT_S', ttl)
        monkeypatch.setattr(swoop_manager, 'TOKEN_REFRESH_LEAD_S', lead)
        monkeypatch.setattr(swoop_manager, 'TOKEN_REFRESH_RETRY_S', retry)

    def test_a_fresh_token_reaches_the_streamer_ahead_of_expiry(self, firebase, monkeypatch):
        self._fast(monkeypatch)
        backend = FakeSpawn()
        manager = make_manager(backend, firebase)
        manager.ensure_streamer('sid_1')
        assert wait_for(lambda: any(w.get('type') == 'token' for w in backend.proc.written))
        line = next(w for w in backend.proc.written if w.get('type') == 'token')
        # the second mint's token, not the one the bundle carried
        assert line == {'type': 'token', 'host_token': 'host-token-2'}
        actions = [call.args[0] for call in firebase.log_event.call_args_list]
        assert 'swoop_token_refreshed' in actions
        manager.kill()

    def test_a_kill_cancels_the_refresh(self, firebase, monkeypatch):
        self._fast(monkeypatch)
        backend = FakeSpawn()
        manager = make_manager(backend, firebase)
        manager.ensure_streamer('sid_1')
        assert wait_for(lambda: backend.spawned == 1)
        manager.kill()
        assert wait_for(lambda: manager.status()['state'] == 'idle')
        time.sleep(1.5)
        assert backend.fetched == 1
        assert not any(w.get('type') == 'token' for w in backend.proc.written)

    def test_a_failed_mint_with_no_time_left_is_logged_not_retried_forever(self, firebase, monkeypatch):
        self._fast(monkeypatch, ttl=2, lead=1, retry=20)
        backend = FakeSpawn(bundle_error=RuntimeError('api down'), bundle_error_after=2)
        manager = make_manager(backend, firebase)
        manager.ensure_streamer('sid_1')
        assert wait_for(lambda: any(
            call.args[0] == 'swoop_token_refresh_failed' for call in firebase.log_event.call_args_list))
        assert not any(w.get('type') == 'token' for w in backend.proc.written)
        manager.kill()

    def test_a_failed_mint_with_time_left_retries(self, firebase, monkeypatch):
        self._fast(monkeypatch, ttl=4, lead=3, retry=1)
        backend = FakeSpawn(bundle_error=RuntimeError('blip'), bundle_error_after=2)
        manager = make_manager(backend, firebase)
        manager.ensure_streamer('sid_1')
        assert wait_for(lambda: backend.fetched >= 2)
        # the second fetch failed; let it recover for the third
        backend.bundle_error = None
        assert wait_for(lambda: any(w.get('type') == 'token' for w in backend.proc.written), timeout=4.0)
        manager.kill()
