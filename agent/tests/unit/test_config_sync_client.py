"""tests for config sync at the client and detector level.

Covers the places where suppressing an echo can cost data:
  * the auto-restore breaker's counter, which round-trips through config.json;
  * a dashboard edit landing between a push's write and its re-read;
  * a failed startup read being mistaken for an absent document;
and the main loop's push detector, whose retry pacing keeps a permanently
failing push off the 5s tick.
"""

import hashlib
import json
import threading
import time
from types import SimpleNamespace
from unittest.mock import MagicMock, patch

import pytest

# Plain imports, deliberately: mocking sys.modules with patch.dict evicts every
# module imported inside the block on exit, and re-importing cryptography in the
# same interpreter fails ("PyO3 modules ... may only be initialized once").
import config_sync
from firebase_client import FirebaseClient
from connection_manager import ConnectionState
from firestore_rest_client import FirestoreRestClient


def _hash(doc):
    return hashlib.md5(json.dumps(doc, sort_keys=True).encode()).hexdigest()


def _write_config(path, name, launch_mode='always', bump_mtime=False):
    """Write a one-process config, optionally forcing a distinctly newer mtime.

    Two writes in the same tick of Windows' coarse clock can share an mtime, and
    the detector's cheap gate is exactly that comparison.
    """
    path.write_text(json.dumps(
        {'processes': [{'id': 'p1', 'name': name, 'launch_mode': launch_mode}]}))
    if bump_mtime:
        stamp = time.time() + 5
        import os
        os.utime(str(path), (stamp, stamp))


@pytest.fixture
def rest_client():
    rc = MagicMock(spec=FirestoreRestClient)
    rc.get_document.return_value = None
    rc.collection.return_value = MagicMock()
    return rc


@pytest.fixture
def client(rest_client, tmp_path):
    """A connected FirebaseClient whose caches point at tmp_path."""
    auth = MagicMock()
    auth.get_valid_token.return_value = 'fake-token'
    auth.is_authenticated.return_value = True
    auth.machine_id = 'TEST-MACHINE'
    auth.api_base = 'https://owlette.app/api'

    with patch('firebase_client.FirestoreRestClient', return_value=rest_client), \
         patch('firebase_client.shared_utils') as su:
        su.get_data_path.return_value = str(tmp_path)
        su.APP_VERSION = '3.0.1'
        try:
            fc = FirebaseClient(
                auth_manager=auth,
                project_id='test-project',
                site_id='test-site',
                config_cache_path=str(tmp_path / 'firebase_cache.json'),
            )
        except Exception:  # pragma: no cover - environment guard
            pytest.skip('FirebaseClient construction failed with mocks')
            return

    fc.db = rest_client
    fc.connection_manager._state = ConnectionState.CONNECTED
    return fc


def _config_ref(rest_client):
    """Wire the collection('config')...document(machine) chain to one mock ref."""
    ref = MagicMock()
    machines = MagicMock()
    machines.document.return_value = ref
    site_doc = MagicMock()
    site_doc.collection.return_value = machines
    config_coll = MagicMock()
    config_coll.document.return_value = site_doc
    rest_client.collection.return_value = config_coll
    return ref


# the breaker counter reaches config.json

class TestAutoRestoreStateMirroring:
    def test_the_patch_reaches_config_json(self, client, rest_client):
        _config_ref(rest_client)
        written = {}

        with patch('firebase_client.shared_utils') as su:
            su.CONFIG_PATH = 'C:\\fake\\config.json'
            su.read_config.return_value = {
                'processes': [],
                'displays': {'autoRestore': {
                    'enabled': True,
                    'circuitBreaker': {'failures': 1},
                }},
            }
            su.write_json_to_file.side_effect = (
                lambda data, path: written.update(data=data, path=path))

            client.update_display_autorestore_state(
                {'failures': 2, 'lastFailureAt': '2026-08-20T00:00:00Z'})

        breaker = written['data']['displays']['autoRestore']['circuitBreaker']
        # Without this the counter reads 0 forever and the breaker never trips:
        # _maybe_auto_restore reads failures back off disk.
        assert breaker['failures'] == 2
        assert breaker['lastFailureAt'] == '2026-08-20T00:00:00Z'
        # operator-set siblings are untouched
        assert written['data']['displays']['autoRestore']['enabled'] is True
        assert written['path'] == 'C:\\fake\\config.json'

    def test_the_patch_also_reaches_the_cache(self, client, rest_client):
        _config_ref(rest_client)
        client.cached_config = {'processes': [], 'displays': {'autoRestore': {'enabled': True}}}

        with patch('firebase_client.shared_utils') as su:
            su.read_config.return_value = None  # disk mirror is a no-op here
            client.update_display_autorestore_state({'failures': 3, 'tripped': True})

        breaker = client.cached_config['displays']['autoRestore']['circuitBreaker']
        assert breaker == {'failures': 3, 'tripped': True}

    def test_a_disk_mirror_failure_is_not_fatal(self, client, rest_client):
        _config_ref(rest_client)
        with patch('firebase_client.shared_utils') as su:
            su.read_config.side_effect = OSError('config.json is locked')
            client.update_display_autorestore_state({'failures': 1})  # must not raise


# a dashboard edit racing the push must not be swallowed

class TestPushLocalConfig:
    def test_a_clean_push_anchors_the_echo_guard(self, client, rest_client):
        ref = _config_ref(rest_client)
        base = {'processes': [{'id': 'p1', 'name': 'touch'}]}
        client.cached_config = base
        local = {'processes': [{'id': 'p1', 'name': 'touch', 'launch_mode': 'off'}],
                 'firebase': {'enabled': True}}
        post_write = {'processes': [{'id': 'p1', 'name': 'touch', 'launch_mode': 'off'}]}

        def fake_get_config(*_a, **_kw):
            client.cached_config = post_write
            return post_write

        with patch.object(client, 'get_config', side_effect=fake_get_config):
            assert client.push_local_config(local) is True

        # local-only keys never leave the machine
        assert 'firebase' not in ref.set.call_args[0][0]
        # the echo of our own write is recognised, and the cache moves forward
        assert client._last_uploaded_config_hash == _hash(post_write)
        assert client.cached_config == post_write

    def test_a_concurrent_edit_in_the_post_write_doc_is_left_for_the_listener(
            self, client, rest_client, tmp_path):
        _config_ref(rest_client)
        base = {'processes': [{'id': 'p1', 'name': 'touch'}]}
        client.cached_config = base
        client._save_cached_config(base)
        local = {'processes': [{'id': 'p1', 'name': 'touch', 'launch_mode': 'off'}]}
        # what we sent, PLUS a dashboard edit that landed in the gap
        post_write = {
            'processes': [{'id': 'p1', 'name': 'touch', 'launch_mode': 'off'}],
            'rebootSchedule': {'entries': ['02:00']},
        }

        def fake_get_config(*_a, **_kw):
            client.cached_config = post_write
            return post_write

        with patch.object(client, 'get_config', side_effect=fake_get_config):
            assert client.push_local_config(local) is True

        # Neither guard may suppress the listener's single delivery of this doc:
        # anchoring on it would lose the edit, and the next startup would then
        # read local as newer and destroy it in the cloud too.
        assert client._last_uploaded_config_hash is None
        assert client.cached_config == base
        with open(str(tmp_path / 'firebase_cache.json')) as f:
            assert json.load(f) == base

    def test_server_owned_timestamps_are_never_re_uploaded(self, client, rest_client):
        ref = _config_ref(rest_client)
        client.cached_config = {'processes': []}
        local = {
            'processes': [],
            'displays': {
                'assigned': {'layoutId': 'L1', 'capturedAt': '2026-08-01T00:00:00Z'},
                'autoRestore': {'enabled': True, 'enabledAt': '2026-08-01T00:00:00Z'},
            },
        }

        with patch.object(client, 'get_config', return_value=None):
            client.push_local_config(local)

        sent = ref.set.call_args[0][0]
        # Re-sending these as strings flips the Firestore field type and the
        # dashboard then reads the timestamp as 0.
        assert 'capturedAt' not in sent['displays']['assigned']
        assert 'enabledAt' not in sent['displays']['autoRestore']
        assert sent['displays']['assigned']['layoutId'] == 'L1'

    def test_a_disconnected_client_does_not_push(self, client):
        client.connection_manager._state = ConnectionState.DISCONNECTED
        assert client.push_local_config({'processes': []}) is False


# a failed read is not an absent document

class TestStartupSyncReadFailure:
    """Drives the real get_config on purpose: the bug being guarded is that it
    swallows a failed fetch, and patching it out would hide exactly that."""

    def test_a_failed_read_does_not_seed_over_a_live_document(self, client, rest_client):
        ref = _config_ref(rest_client)
        ref.get.side_effect = RuntimeError('503 Service Unavailable')
        client.cached_config = None  # fresh install, no cache to fall back on

        with patch('firebase_client.shared_utils') as su, \
             patch.object(client, 'upload_config') as upload:
            su.read_config.return_value = {'processes': [{'id': 'p1', 'name': 'touch'}]}
            result = client.sync_config_on_startup()

        assert result == 'offline'
        # A swallowed failure reads as "no document exists", and seeding would
        # put installer defaults over the operator's configured processes.
        upload.assert_not_called()

    def test_an_absent_document_still_seeds(self, client, rest_client):
        ref = _config_ref(rest_client)
        ref.get.return_value = None
        client.cached_config = None

        with patch('firebase_client.shared_utils') as su, \
             patch.object(client, 'upload_config') as upload:
            su.read_config.return_value = {'processes': [{'id': 'p1', 'name': 'touch'}]}
            result = client.sync_config_on_startup()

        assert result == 'seeded'
        upload.assert_called_once()
        assert upload.call_args[0][0] == {'processes': [{'id': 'p1', 'name': 'touch'}]}

    def test_a_cache_fallback_is_not_mistaken_for_a_fresh_read(self, client, rest_client):
        ref = _config_ref(rest_client)
        ref.get.return_value = None  # get_config() then hands the cache back
        base = {'processes': [{'id': 'p1', 'name': 'touch'}]}
        client.cached_config = base

        with patch('firebase_client.shared_utils') as su:
            su.read_config.return_value = {'processes': [{'id': 'p1', 'name': 'other'}]}
            assert client.sync_config_on_startup() == 'offline'


# the main loop's detector: retry pacing for a push that keeps failing

class FakePushClient:
    """Counts push attempts; `succeeds` decides the outcome."""

    def __init__(self, cached_config, succeeds=False):
        self.cached_config = cached_config
        self.succeeds = succeeds
        self.attempts = 0
        self.metrics_uploads = 0

    def is_connected(self):
        return True

    def push_local_config(self, local_config, reason='local change'):
        self.attempts += 1
        return self.succeeds

    def _upload_metrics(self, metrics):
        self.metrics_uploads += 1
        return True


class TestLocalConfigPushDetector:
    @pytest.fixture
    def detector(self, tmp_path, monkeypatch):
        import owlette_service
        from owlette_service import OwletteService

        path = tmp_path / 'config.json'
        _write_config(path, 'touch')
        monkeypatch.setattr(owlette_service.shared_utils, 'CONFIG_PATH', str(path))
        monkeypatch.setattr(
            owlette_service.shared_utils, 'read_config',
            lambda *a, **k: json.loads(path.read_text()),
        )
        monkeypatch.setattr(
            owlette_service.shared_utils, 'get_system_metrics',
            lambda: {'memory': {}, 'processes': {}},
        )

        # cached_config differs from disk, so every tick sees work to do.
        client = FakePushClient({'processes': [{'id': 'p1', 'name': 'stale'}]})
        svc = SimpleNamespace(
            firebase_client=client,
            _local_config_mtime=None,
            _applying_remote_config=False,
            _config_push_thread=None,
            _config_baseline_lock=threading.Lock(),
            _push_backoff=config_sync.PushBackoff(),
            _push_attempt_mtime=None,
        )
        svc._check_local_config_changes = (
            OwletteService._check_local_config_changes.__get__(svc, OwletteService)
        )
        return svc, path, client

    def _tick(self, svc):
        """One watcher tick, waited out — the push runs on its own thread."""
        svc._check_local_config_changes()
        if svc._config_push_thread is not None:
            svc._config_push_thread.join(timeout=5)

    def test_a_failing_push_is_not_retried_on_the_next_tick(self, detector):
        svc, _path, client = detector

        self._tick(svc)
        assert client.attempts == 1
        assert svc._push_backoff.failures == 1

        # Same edit, still failing: the 5s backoff has to hold the next ticks off,
        # or a rules denial means a Firestore write every 5s forever.
        self._tick(svc)
        self._tick(svc)
        assert client.attempts == 1

    def test_a_fresh_edit_is_attempted_at_once_despite_the_backoff(self, detector):
        svc, path, client = detector

        for _ in range(3):
            self._tick(svc)
        assert client.attempts == 1

        # The operator changes something again.
        _write_config(path, 'touch', launch_mode='off', bump_mtime=True)
        self._tick(svc)

        assert client.attempts == 2
        assert svc._push_attempt_mtime is not None

    def test_a_successful_push_returns_to_full_speed(self, detector):
        svc, _path, client = detector
        client.succeeds = True

        self._tick(svc)

        assert client.attempts == 1
        assert svc._push_backoff.failures == 0

    def test_a_successful_push_publishes_metrics_immediately(self, detector):
        # The dashboard draws process rows from metrics.processes, so a local
        # add/delete/rename is invisible until a heartbeat lands — up to 120s
        # idle. A successful push must therefore be followed by one immediate
        # metrics upload, mirroring what handle_config_update does for remote
        # applies.
        svc, _path, client = detector
        client.succeeds = True

        self._tick(svc)

        assert client.metrics_uploads == 1

    def test_a_failed_push_does_not_publish_metrics(self, detector):
        svc, _path, client = detector
        client.succeeds = False

        self._tick(svc)

        assert client.metrics_uploads == 0

    def test_nothing_is_pushed_while_a_remote_apply_is_running(self, detector):
        svc, _path, client = detector
        svc._applying_remote_config = True

        self._tick(svc)

        assert client.attempts == 0

    def test_a_config_matching_the_cache_is_not_pushed(self, detector):
        svc, path, client = detector
        client.cached_config = json.loads(path.read_text())

        self._tick(svc)

        assert client.attempts == 0
        assert svc._local_config_mtime is not None  # baseline adopted instead


class TestLocalConfigWatcher:
    """The detector's own thread. It used to ride the 5s main loop, which put up
    to a full tick in front of every desktop-app edit."""

    @pytest.fixture
    def watcher(self, monkeypatch):
        import owlette_service
        from owlette_service import OwletteService

        monkeypatch.setattr(owlette_service, 'LOCAL_CONFIG_POLL_INTERVAL', 0.01)
        # the console look on each tick is covered in
        # test_owlette_service_hardening.py.
        svc = SimpleNamespace(is_alive=True, _check_console_session=lambda: None)
        svc.start_local_config_watcher = (
            OwletteService.start_local_config_watcher.__get__(svc, OwletteService)
        )
        return svc

    def test_it_polls_until_the_service_stops(self, watcher):
        ticks = []
        watcher._check_local_config_changes = lambda: ticks.append(1)

        thread = watcher.start_local_config_watcher()
        time.sleep(0.1)
        watcher.is_alive = False
        thread.join(timeout=5)

        assert not thread.is_alive()
        assert len(ticks) >= 2  # it really was polling, not firing once
        # Nothing after the liveness flag dropped.
        settled = len(ticks)
        time.sleep(0.05)
        assert len(ticks) == settled

    def test_a_failing_tick_does_not_kill_the_watcher(self, watcher):
        ticks = []

        def boom():
            ticks.append(1)
            raise RuntimeError('config.json vanished mid-tick')

        watcher._check_local_config_changes = boom

        thread = watcher.start_local_config_watcher()
        time.sleep(0.1)
        watcher.is_alive = False
        thread.join(timeout=5)

        assert not thread.is_alive()
        # One bad tick must not end detection for the life of the service.
        assert len(ticks) >= 2

    def test_the_main_loop_starts_it_and_no_longer_calls_the_detector(self):
        """Moved, not duplicated.

        _check_local_config_changes assumes a single invoker — single-flight
        dispatch and the mtime baseline CAS both break under two — so the main
        loop must hand detection over rather than share it.
        """
        import inspect
        import owlette_service

        main_src = inspect.getsource(owlette_service.OwletteService.main)
        assert 'start_local_config_watcher()' in main_src
        assert '_check_local_config_changes()' not in main_src

    def test_the_watcher_is_the_detectors_only_caller(self):
        import inspect
        import owlette_service

        module_src = inspect.getsource(owlette_service)
        assert module_src.count('self._check_local_config_changes()') == 1

    def test_it_is_a_daemon_so_it_cannot_hold_the_process_open(self, watcher):
        watcher._check_local_config_changes = lambda: None

        thread = watcher.start_local_config_watcher()
        try:
            assert thread.daemon is True
            assert thread.name == 'owlette-local-config-watch'
        finally:
            watcher.is_alive = False
            thread.join(timeout=5)
