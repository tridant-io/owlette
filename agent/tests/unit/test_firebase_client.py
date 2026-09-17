"""Tests for firebase_client.py — high-level Firebase client (presence, metrics, commands)."""

import pytest
from unittest.mock import MagicMock, patch, PropertyMock
import logging
import time
import sys

# Pre-mock Windows-specific and heavy deps before importing firebase_client
_MOCK_MODULES = {
    "win32api": MagicMock(),
    "win32con": MagicMock(),
    "win32event": MagicMock(),
    "win32service": MagicMock(),
    "win32serviceutil": MagicMock(),
    "servicemanager": MagicMock(),
    "win32ts": MagicMock(),
    "win32process": MagicMock(),
    "win32gui": MagicMock(),
    "win32security": MagicMock(),
    "pywintypes": MagicMock(),
    "wmi": MagicMock(),
}

# Only patch modules that aren't already importable
_patches = {}
for mod_name, mock_obj in _MOCK_MODULES.items():
    if mod_name not in sys.modules:
        _patches[mod_name] = mock_obj

try:
    _before = set(sys.modules)
    with patch.dict("sys.modules", _patches):
        from firebase_client import FirebaseClient, DISPLAY_ALERT_EVENT_TYPES
        from command_router import COMMAND_DEFERRED
        from connection_manager import ConnectionManager, ConnectionState
        from firestore_rest_client import FirestoreRestClient
        from auth_manager import AuthManager
        # patch.dict restores sys.modules wholesale on exit, evicting every
        # module these imports added while the classes above stay bound to it.
        # A later patch("firebase_client.<name>") would then import a SECOND
        # firebase_client and stub that one, leaving the constructor reading the
        # real shared_utils — which reads and seeds the machine identity. Keep
        # what the imports produced; in a full-suite run they were already there.
        _imported = {name: module for name, module in sys.modules.items()
                     if name not in _before and name not in _patches}
    sys.modules.update(_imported)
except ImportError as exc:
    pytest.skip(f"firebase_client not importable: {exc}", allow_module_level=True)
except Exception as exc:
    pytest.skip(f"firebase_client import failed: {exc}", allow_module_level=True)


@pytest.fixture
def logger():
    return logging.getLogger("test_firebase_client")


@pytest.fixture
def mock_auth_manager():
    """Mock AuthManager that claims to be authenticated."""
    am = MagicMock(spec=AuthManager)
    am.get_valid_token.return_value = "fake-token"
    am.is_authenticated.return_value = True
    am._site_id = "test-site"
    am.machine_id = "TEST-MACHINE"
    am.api_base = "https://owlette.app/api"
    return am


@pytest.fixture
def mock_rest_client():
    """Pre-built mock FirestoreRestClient."""
    rc = MagicMock(spec=FirestoreRestClient)
    rc.get_document.return_value = None
    rc.set_document.return_value = None
    rc.update_document.return_value = None
    rc.delete_document.return_value = None
    rc.collection.return_value = MagicMock()
    return rc


@pytest.fixture
def firebase_client(mock_auth_manager, mock_rest_client):
    """Create a FirebaseClient with all dependencies mocked out."""
    with patch("firebase_client.FirestoreRestClient", return_value=mock_rest_client), \
         patch("firebase_client.shared_utils") as mock_su:
        # shared_utils stubs
        mock_su.get_data_path.return_value = "/tmp/owlette"
        mock_su.get_system_metrics.return_value = {"cpu": 10, "memory": 50}
        mock_su.APP_VERSION = "2.2.1"
        # machine_id is read straight off shared_utils in __init__; without a
        # stub it becomes a MagicMock and every id-shaped assertion depends on
        # whether this module was still in sys.modules when patch() resolved it.
        mock_su.get_machine_id.return_value = "TEST-MACHINE"

        try:
            client = FirebaseClient(
                auth_manager=mock_auth_manager,
                project_id="test-project",
                site_id="test-site",
            )
        except Exception:
            pytest.skip("FirebaseClient construction failed with mocks")
            return

        # Constructor may or may not have set db.
        client.db = mock_rest_client
        return client


# TestInit — construction with mocked dependencies
class TestInit:
    def test_can_construct(self, firebase_client):
        """FirebaseClient should be constructable with mocked deps."""
        assert firebase_client is not None

    def test_has_connection_manager(self, firebase_client):
        assert firebase_client.connection_manager is not None
        assert isinstance(firebase_client.connection_manager, ConnectionManager)

    def test_site_id_stored(self, firebase_client):
        assert firebase_client.site_id == "test-site"

    def test_machine_id_is_set(self, firebase_client):
        """The persisted identity, taken from the stub rather than from the
        machine — an id that is really the hostname means the fixture's
        shared_utils stub landed on a different module object than the
        constructor reads, and the constructor seeded a real identity file."""
        assert firebase_client.machine_id == "TEST-MACHINE"


# TestPresence — heartbeat writes to the correct Firestore path
class TestPresence:
    def test_update_presence_calls_firestore(self, firebase_client, mock_rest_client):
        """_update_presence should write to Firestore via collection/document chain."""
        firebase_client.running = True
        firebase_client.connection_manager._state = ConnectionState.CONNECTED

        mock_doc_ref = MagicMock()
        mock_machine_coll = MagicMock()
        mock_machine_coll.document.return_value = mock_doc_ref
        mock_site_doc = MagicMock()
        mock_site_doc.collection.return_value = mock_machine_coll
        mock_sites_coll = MagicMock()
        mock_sites_coll.document.return_value = mock_site_doc
        mock_rest_client.collection.return_value = mock_sites_coll

        firebase_client._update_presence(True)

        mock_rest_client.collection.assert_called_with("sites")
        mock_sites_coll.document.assert_called_with("test-site")
        mock_site_doc.collection.assert_called_with("machines")
        mock_doc_ref.set.assert_called_once()
        call_data = mock_doc_ref.set.call_args[0][0]
        assert call_data["online"] is True


# TestMetrics — _upload_metrics writes the correct data structure
class TestMetrics:
    def test_upload_metrics_calls_firestore(self, firebase_client, mock_rest_client):
        """_upload_metrics should update the machine document with metrics."""
        firebase_client.running = True
        firebase_client.connection_manager._state = ConnectionState.CONNECTED

        mock_doc_ref = MagicMock()
        mock_machine_coll = MagicMock()
        mock_machine_coll.document.return_value = mock_doc_ref
        mock_site_doc = MagicMock()
        mock_site_doc.collection.return_value = mock_machine_coll
        mock_sites_coll = MagicMock()
        mock_sites_coll.document.return_value = mock_site_doc
        mock_rest_client.collection.return_value = mock_sites_coll

        metrics_data = {
            "cpu_percent": 45.2,
            "memory_percent": 67.8,
            "processes": {"proc1": {"status": "running"}},
        }

        firebase_client._upload_metrics(metrics_data)

        assert mock_doc_ref.update.called


# TestErrorHandling — connection errors handled gracefully
class TestErrorHandling:
    def test_presence_skipped_when_disconnected(self, firebase_client, mock_rest_client):
        """When disconnected, _update_presence should skip without error."""
        firebase_client.connection_manager._state = ConnectionState.DISCONNECTED

        firebase_client._update_presence(True)
        mock_rest_client.collection.assert_not_called()

    def test_presence_skipped_when_db_is_none(self, firebase_client):
        """When db is None, _update_presence should skip."""
        firebase_client.connection_manager._state = ConnectionState.CONNECTED
        firebase_client.db = None

        firebase_client._update_presence(True)


# TestSiteMetadataFromApi — GET /api/agent/site, the path that actually resolves
class TestSiteMetadataFromApi:
    """Site display name AND schedule timezone come from `GET /api/agent/site` —
    rules scope the agent to its own machine subtree, so it cannot read
    `sites/{siteId}`.

    Three load-bearing invariants: the API answer short-circuits the Firestore
    read; the timezone is mirrored exactly as sent, including `null` (the server
    owns the `schedulesFollowSiteTime` policy, the agent never re-derives it); and
    an API failure must not latch — the endpoint may just not be deployed yet, so
    the next connect and the 900s refresh both retry.
    """

    @staticmethod
    def _response(status=200, payload=None):
        resp = MagicMock()
        resp.status_code = status
        resp.json.return_value = payload if payload is not None else {}
        return resp

    def test_caches_the_name_from_the_endpoint_and_skips_firestore(
        self, firebase_client, mock_rest_client
    ):
        mock_rest_client.get_document.reset_mock()
        with patch('firebase_client.shared_utils.get_api_base_url',
                   return_value='https://dev.owlette.app/api'), \
             patch('requests.get', return_value=self._response(200, {'name': 'TEC'})) as get:
            firebase_client._fetch_site_metadata()

        assert firebase_client.site_name == 'TEC'
        get.assert_called_once()
        assert get.call_args[0][0] == 'https://dev.owlette.app/api/agent/site'
        assert get.call_args[1]['headers'] == {'Authorization': 'Bearer fake-token'}
        # The site rides on the token, so nothing is sent with the request.
        assert 'params' not in get.call_args[1]
        # An API answer is the whole answer — no site-document read.
        mock_rest_client.get_document.assert_not_called()

    def test_takes_the_timezone_the_endpoint_offers(self, firebase_client):
        # The inversion of the deferral guard this replaces (which asserted
        # `site_timezone is None` against this exact response). The route only
        # sends a timezone for a site whose `schedulesFollowSiteTime` is true, so
        # caching it here IS the opt-in landing on the machine.
        with patch('firebase_client.shared_utils.get_api_base_url',
                   return_value='https://dev.owlette.app/api'), \
             patch('requests.get',
                   return_value=self._response(200, {'name': 'TEC', 'timezone': 'America/Los_Angeles'})):
            firebase_client._fetch_site_metadata()

        assert firebase_client.site_name == 'TEC'
        assert firebase_client.site_timezone == 'America/Los_Angeles'

    def test_a_null_timezone_clears_a_cached_one(self, firebase_client):
        # Opting back out has to reach the fleet. Guarding the assignment with
        # `if timezone:` would leave every machine evaluating its windows against
        # the timezone the site just abandoned, until the next service restart.
        firebase_client.site_timezone = 'America/Los_Angeles'

        with patch('firebase_client.shared_utils.get_api_base_url',
                   return_value='https://dev.owlette.app/api'), \
             patch('requests.get',
                   return_value=self._response(200, {'name': 'TEC', 'timezone': None})):
            firebase_client._fetch_site_metadata()

        assert firebase_client.site_timezone is None

    def test_a_site_that_never_opted_in_stays_on_machine_local_time(self, firebase_client):
        # The overwhelmingly common shape: absent flag ⇒ the route omits the key
        # entirely ⇒ machine-local, exactly as every pre-3.3.0 agent behaved.
        with patch('firebase_client.shared_utils.get_api_base_url',
                   return_value='https://dev.owlette.app/api'), \
             patch('requests.get', return_value=self._response(200, {'name': 'TEC'})):
            firebase_client._fetch_site_metadata()

        assert firebase_client.site_timezone is None

    def test_a_padded_timezone_is_trimmed_and_a_blank_one_is_not_a_timezone(
        self, firebase_client
    ):
        with patch('firebase_client.shared_utils.get_api_base_url',
                   return_value='https://dev.owlette.app/api'), \
             patch('requests.get',
                   return_value=self._response(200, {'name': 'TEC', 'timezone': '  Asia/Tokyo  '})):
            firebase_client._fetch_site_metadata()
        assert firebase_client.site_timezone == 'Asia/Tokyo'

        with patch('firebase_client.shared_utils.get_api_base_url',
                   return_value='https://dev.owlette.app/api'), \
             patch('requests.get',
                   return_value=self._response(200, {'name': 'TEC', 'timezone': '   '})):
            firebase_client._fetch_site_metadata()
        # Whitespace is not a zone — and it must clear, not linger.
        assert firebase_client.site_timezone is None

    def test_only_the_transitions_are_logged(self, firebase_client):
        # The 900s refresh re-answers the same question 96 times a day. Logging
        # every answer would bury the one line that matters — the change.
        payload = self._response(200, {'name': 'TEC', 'timezone': 'Asia/Tokyo'})
        with patch('firebase_client.shared_utils.get_api_base_url',
                   return_value='https://dev.owlette.app/api'), \
             patch('requests.get', return_value=payload), \
             patch.object(firebase_client, 'logger') as logger:
            firebase_client._fetch_site_metadata()
            first_pass = logger.info.call_count
            firebase_client._fetch_site_metadata()
            firebase_client._fetch_site_metadata()

            assert logger.info.call_count == first_pass

            # …but a real change still speaks up.
            payload.json.return_value = {'name': 'TEC', 'timezone': None}
            firebase_client._fetch_site_metadata()
            assert logger.info.call_count > first_pass

    def test_an_unnamed_site_answers_null_and_still_settles_the_question(
        self, firebase_client, mock_rest_client
    ):
        mock_rest_client.get_document.reset_mock()
        with patch('firebase_client.shared_utils.get_api_base_url',
                   return_value='https://dev.owlette.app/api'), \
             patch('requests.get', return_value=self._response(200, {'name': None})):
            firebase_client._fetch_site_metadata()

        assert firebase_client.site_name is None
        mock_rest_client.get_document.assert_not_called()

    def test_a_non_200_falls_through_to_the_firestore_read(
        self, firebase_client, mock_rest_client
    ):
        mock_rest_client.get_document.reset_mock()
        mock_rest_client.get_document.return_value = {'name': 'TEC', 'timezone': 'UTC'}
        with patch('firebase_client.shared_utils.get_api_base_url',
                   return_value='https://dev.owlette.app/api'), \
             patch('requests.get', return_value=self._response(404)):
            firebase_client._fetch_site_metadata()

        mock_rest_client.get_document.assert_called_once_with('sites/test-site')
        assert firebase_client.site_name == 'TEC'

    def test_a_network_failure_falls_through_without_raising(
        self, firebase_client, mock_rest_client
    ):
        mock_rest_client.get_document.reset_mock()
        mock_rest_client.get_document.return_value = None
        with patch('firebase_client.shared_utils.get_api_base_url',
                   return_value='https://dev.owlette.app/api'), \
             patch('requests.get', side_effect=OSError('connection reset by peer')):
            firebase_client._fetch_site_metadata()

        mock_rest_client.get_document.assert_called_once()
        assert firebase_client.site_name is None

    def test_the_failure_is_warned_once_but_retried_every_time(
        self, firebase_client, mock_rest_client
    ):
        # An undeployed endpoint is a server fact, not a permanent agent one —
        # retry every connect, log once.
        mock_rest_client.get_document.return_value = None
        with patch('firebase_client.shared_utils.get_api_base_url',
                   return_value='https://dev.owlette.app/api'), \
             patch('requests.get', return_value=self._response(404)) as get, \
             patch.object(firebase_client, 'logger') as logger:
            firebase_client._fetch_site_metadata()
            firebase_client._fetch_site_metadata()
            firebase_client._fetch_site_metadata()

        assert get.call_count == 3
        assert logger.warning.call_count == 1

    def test_recovers_on_a_later_connect_once_the_route_is_deployed(
        self, firebase_client, mock_rest_client
    ):
        mock_rest_client.get_document.return_value = None
        with patch('firebase_client.shared_utils.get_api_base_url',
                   return_value='https://dev.owlette.app/api'), \
             patch('requests.get',
                   side_effect=[self._response(404), self._response(200, {'name': 'TEC'})]):
            firebase_client._fetch_site_metadata()
            assert firebase_client.site_name is None
            firebase_client._fetch_site_metadata()

        assert firebase_client.site_name == 'TEC'

    def test_a_padded_name_is_trimmed(self, firebase_client):
        with patch('firebase_client.shared_utils.get_api_base_url',
                   return_value='https://dev.owlette.app/api'), \
             patch('requests.get', return_value=self._response(200, {'name': '  TEC  '})):
            firebase_client._fetch_site_metadata()

        assert firebase_client.site_name == 'TEC'


# TestSiteMetadata — the sites/{siteId} read kept for a future rule grant
class TestSiteMetadata:
    """`_fetch_site_metadata` caches the site timezone (schedule evaluation) and
    display name. Both optional — consumers fall back to machine-local time and
    the site id — so an unreadable site document must not raise.

    Covers the Firestore fallback: the API lookup declines throughout (see
    `TestSiteMetadataFromApi` for the path it declines from).

    This path reads the raw site document, so unlike the API path it has to apply
    the `schedulesFollowSiteTime` opt-in itself. It must never be the loophole
    that turns site-time scheduling on for a site that declined it.
    """

    @pytest.fixture(autouse=True)
    def _api_declines(self, firebase_client):
        with patch.object(firebase_client, '_fetch_site_metadata_from_api', return_value=False):
            yield

    def test_a_site_that_has_not_opted_in_keeps_machine_local_time(
        self, firebase_client, mock_rest_client
    ):
        # A timezone on the site document is not consent: it has been set on
        # nearly every site for years, purely for dashboard display.
        mock_rest_client.get_document.reset_mock()
        mock_rest_client.get_document.return_value = {
            'name': 'TEC',
            'timezone': 'America/Los_Angeles',
        }

        firebase_client._fetch_site_metadata()

        assert firebase_client.site_name == 'TEC'
        assert firebase_client.site_timezone is None
        # One round trip, on the site document itself.
        mock_rest_client.get_document.assert_called_once_with('sites/test-site')

    def test_the_flagged_twin_caches_the_timezone(self, firebase_client, mock_rest_client):
        mock_rest_client.get_document.reset_mock()
        mock_rest_client.get_document.return_value = {
            'name': 'TEC',
            'timezone': 'America/Los_Angeles',
            'schedulesFollowSiteTime': True,
        }

        firebase_client._fetch_site_metadata()

        assert firebase_client.site_name == 'TEC'
        assert firebase_client.site_timezone == 'America/Los_Angeles'

    def test_a_declining_site_clears_a_cached_timezone(self, firebase_client, mock_rest_client):
        firebase_client.site_timezone = 'America/Los_Angeles'
        mock_rest_client.get_document.return_value = {
            'name': 'TEC',
            'timezone': 'America/Los_Angeles',
            'schedulesFollowSiteTime': False,
        }

        firebase_client._fetch_site_metadata()

        assert firebase_client.site_timezone is None

    @pytest.mark.parametrize('flag', ['true', 1, 'yes', {}, []])
    def test_only_a_real_true_opts_a_site_in(self, firebase_client, mock_rest_client, flag):
        # `is True`, not truthiness: a string "true" out of a hand-edited document
        # or a loose REST decode must not move a fleet onto a different clock.
        mock_rest_client.get_document.return_value = {
            'name': 'TEC',
            'timezone': 'America/Los_Angeles',
            'schedulesFollowSiteTime': flag,
        }

        firebase_client._fetch_site_metadata()

        assert firebase_client.site_timezone is None

    def test_an_unnamed_site_leaves_the_name_unset(self, firebase_client, mock_rest_client):
        # Pre-name-column or whitespace-only sites must yield None (not ''), so
        # the consumer falls back to the site id.
        mock_rest_client.get_document.return_value = {
            'timezone': 'UTC', 'name': '', 'schedulesFollowSiteTime': True,
        }

        firebase_client._fetch_site_metadata()

        assert firebase_client.site_name is None
        assert firebase_client.site_timezone == 'UTC'

    def test_a_missing_site_document_changes_nothing(self, firebase_client, mock_rest_client):
        firebase_client.site_name = 'TEC'
        mock_rest_client.get_document.return_value = None

        firebase_client._fetch_site_metadata()

        assert firebase_client.site_name == 'TEC'

    def test_a_denial_is_said_once_and_then_stops_being_asked(
        self, firebase_client, mock_rest_client
    ):
        # Live failure mode: the agent's token has no site-level read, so this
        # 403s forever. One warning, one attempt, never raise — raising would take
        # the connect path down.
        mock_rest_client.get_document.reset_mock()
        mock_rest_client.get_document.side_effect = RuntimeError(
            '403 Client Error: Forbidden for url: https://firestore.googleapis.com/…')

        with patch.object(firebase_client, 'logger') as logger:
            firebase_client._fetch_site_metadata()
            firebase_client._fetch_site_metadata()

        assert firebase_client.site_name is None
        assert firebase_client.site_timezone is None
        assert logger.warning.call_count == 1
        assert mock_rest_client.get_document.call_count == 1

    def test_a_transient_failure_is_quiet_and_tried_again(
        self, firebase_client, mock_rest_client
    ):
        # A dropped socket says nothing about permission — next connect retries,
        # silently.
        mock_rest_client.get_document.reset_mock()
        mock_rest_client.get_document.side_effect = [
            OSError('connection reset by peer'),
            {'name': 'TEC'},
        ]

        with patch.object(firebase_client, 'logger') as logger:
            firebase_client._fetch_site_metadata()
            assert firebase_client.site_name is None
            firebase_client._fetch_site_metadata()

        assert firebase_client.site_name == 'TEC'
        assert logger.warning.call_count == 0
        assert logger.debug.call_count == 1

    def test_skips_the_read_when_there_is_no_client(self, firebase_client, mock_rest_client):
        firebase_client.db = None
        mock_rest_client.get_document.reset_mock()

        firebase_client._fetch_site_metadata()

        mock_rest_client.get_document.assert_not_called()


# TestSiteMetadataRefresh — the 900s re-read that keeps the cache honest
class TestSiteMetadataRefresh:
    """Site metadata used to be read once per connect, so a site opting into
    site-time schedules (or renaming itself) reached a machine only on its next
    reconnect — for a healthy agent, potentially days.

    It is paced on the METRICS thread, deliberately: `_fetch_site_metadata` is an
    HTTP round trip with a 10s timeout, and the 5s main service loop must never
    block on the network. These are structural assertions because `_metrics_loop`
    is an unbounded `while self.running` loop that uploads telemetry — the repo
    guards such loops the same way elsewhere.
    """

    @staticmethod
    def _loop_src():
        import inspect
        return inspect.getsource(FirebaseClient._metrics_loop)

    def test_the_metrics_loop_refreshes_the_metadata(self):
        assert 'self._fetch_site_metadata()' in self._loop_src()

    def test_it_is_paced_at_900s_like_the_cleanup_beside_it(self):
        src = self._loop_src()
        assert 'last_site_metadata_refresh' in src
        assert 'now - last_site_metadata_refresh > 900' in src

    def test_a_failed_refresh_cannot_take_the_heartbeat_thread_down(self):
        # This loop IS the heartbeat: an escaping exception marks the machine
        # offline fleet-wide. The refresh is best-effort, like the cleanup.
        src = self._loop_src()
        after = src.split('self._fetch_site_metadata()', 1)[1]
        assert 'except Exception' in after.split('\n\n', 1)[0]

    def test_it_only_runs_while_connected(self):
        src = self._loop_src()
        # Same `if self.connected:` arm as the metrics upload and the cleanup —
        # there is nothing to ask while the transport is down.
        assert src.index('if self.connected:') < src.index('self._fetch_site_metadata()')


# TestEnsureDisplayModesCatalogue — A3.2 cache-by-signature guard
@pytest.mark.windows(reason='patches display_manager, which is windows-only')
class TestEnsureDisplayModesCatalogue:
    """`_ensure_display_modes_catalogue` uploads once per signatureHash. The
    dashboard dispatches `enumerate_display_modes` every time the editor opens,
    so the cache-by-hash guard keeps a stable topology cheap.
    """

    def _canned_result(self, signature_hash: str = 'hash-abc-123'):
        return {
            'ok': True,
            'schemaVersion': 1,
            'signatureHash': signature_hash,
            'capturedAt': 1_700_000_000,
            'byEdidHash': {
                'edid-1': {
                    'modes': [
                        {'w': 3840, 'h': 2160, 'hz': 60},
                        {'w': 1920, 'h': 1080, 'hz': 60},
                    ],
                    'dpiScales': [100, 125, 150, 175, 200],
                },
            },
            'enumerationFailed': False,
        }

    def _patch_enumerate(self, monkeypatch, result):
        import display_manager
        monkeypatch.setattr(
            display_manager,
            'enumerate_modes_via_user_session',
            lambda: result,
        )

    def test_uploads_on_first_call(self, firebase_client, mock_rest_client, monkeypatch):
        firebase_client.connection_manager._state = ConnectionState.CONNECTED
        self._patch_enumerate(monkeypatch, self._canned_result())
        result = firebase_client._ensure_display_modes_catalogue()
        assert result['ok'] is True
        assert result['uploaded'] is True
        assert result['monitorCount'] == 1
        assert result['modeCount'] == 2
        assert firebase_client._cached_display_modes_hash == 'hash-abc-123'

    def test_second_call_with_unchanged_hardware_is_noop(
        self, firebase_client, mock_rest_client, monkeypatch,
    ):
        firebase_client.connection_manager._state = ConnectionState.CONNECTED
        self._patch_enumerate(monkeypatch, self._canned_result())
        firebase_client._ensure_display_modes_catalogue()
        # Reset so the second call can assert `set()` was NOT called.
        mock_rest_client.reset_mock()
        second = firebase_client._ensure_display_modes_catalogue()
        assert second['ok'] is True
        assert second['uploaded'] is False
        assert second['reason'] == 'unchanged'
        # No Firestore writes for the redundant dispatch.
        mock_rest_client.collection.assert_not_called()

    def test_force_bypasses_cache(self, firebase_client, mock_rest_client, monkeypatch):
        firebase_client.connection_manager._state = ConnectionState.CONNECTED
        self._patch_enumerate(monkeypatch, self._canned_result())
        firebase_client._ensure_display_modes_catalogue()
        mock_rest_client.reset_mock()
        forced = firebase_client._ensure_display_modes_catalogue(force=True)
        assert forced['uploaded'] is True
        # set() ran on the second call despite an unchanged hash.
        mock_rest_client.collection.assert_called()

    def test_changed_hash_uploads_again(
        self, firebase_client, mock_rest_client, monkeypatch,
    ):
        firebase_client.connection_manager._state = ConnectionState.CONNECTED
        self._patch_enumerate(monkeypatch, self._canned_result('hash-A'))
        firebase_client._ensure_display_modes_catalogue()
        mock_rest_client.reset_mock()
        self._patch_enumerate(monkeypatch, self._canned_result('hash-B'))
        second = firebase_client._ensure_display_modes_catalogue()
        assert second['uploaded'] is True
        assert firebase_client._cached_display_modes_hash == 'hash-B'
        mock_rest_client.collection.assert_called()

    def test_enumeration_failed_skips_upload(
        self, firebase_client, mock_rest_client, monkeypatch,
    ):
        firebase_client.connection_manager._state = ConnectionState.CONNECTED
        result = self._canned_result()
        result['enumerationFailed'] = True
        result['byEdidHash'] = {}
        self._patch_enumerate(monkeypatch, result)
        out = firebase_client._ensure_display_modes_catalogue()
        assert out['ok'] is True
        assert out['uploaded'] is False
        assert out['reason'] == 'enumeration_failed'
        mock_rest_client.collection.assert_not_called()

    def test_helper_failure_passes_through(
        self, firebase_client, mock_rest_client, monkeypatch,
    ):
        firebase_client.connection_manager._state = ConnectionState.CONNECTED
        self._patch_enumerate(monkeypatch, {
            'ok': False,
            'error': 'helper spawn failed',
            'code': 'helper_failed',
        })
        out = firebase_client._ensure_display_modes_catalogue()
        assert out['ok'] is False
        assert out['code'] == 'helper_failed'
        mock_rest_client.collection.assert_not_called()

    def test_skipped_when_disconnected(
        self, firebase_client, mock_rest_client, monkeypatch,
    ):
        firebase_client.connection_manager._state = ConnectionState.DISCONNECTED
        self._patch_enumerate(monkeypatch, self._canned_result())
        out = firebase_client._ensure_display_modes_catalogue()
        assert out['ok'] is True
        assert out['uploaded'] is False
        assert out['reason'] == 'offline'
        mock_rest_client.collection.assert_not_called()


# TestTerminalCommandStatus — completed vs failed hangs on the "Error:" prefix
# in the handler result. roost handlers once returned "sync_pull failed: ..."
# with no prefix, so a refused deploy was stored as status:'completed'.
class TestTerminalCommandStatus:
    @staticmethod
    def _run(firebase_client, result, monkeypatch):
        firebase_client.connection_manager._state = ConnectionState.CONNECTED
        firebase_client.command_callback = lambda cmd_id, cmd_data: result
        monkeypatch.setattr(firebase_client, '_mark_command_running', MagicMock())
        monkeypatch.setattr(firebase_client, '_mark_command_completed', MagicMock())
        monkeypatch.setattr(firebase_client, '_mark_command_failed', MagicMock())
        monkeypatch.setattr(firebase_client, '_upload_metrics', MagicMock())
        with patch('firebase_client.shared_utils'):
            firebase_client._execute_command('cmd-1', {'type': 'sync_pull'})
        return firebase_client

    def test_error_prefixed_result_is_marked_failed(self, firebase_client, monkeypatch):
        client = self._run(
            firebase_client,
            'Error: sync_pull refused: extract_root is not allowed by '
            'destination_allowlist',
            monkeypatch,
        )
        client._mark_command_failed.assert_called_once()
        client._mark_command_completed.assert_not_called()
        assert 'destination_allowlist' in client._mark_command_failed.call_args[0][1]

    def test_success_result_is_marked_completed(self, firebase_client, monkeypatch):
        client = self._run(
            firebase_client, 'sync_pull complete (distribution 3)', monkeypatch,
        )
        client._mark_command_completed.assert_called_once()
        client._mark_command_failed.assert_not_called()

    def test_a_deferred_command_gets_no_terminal_status_here(
        self, firebase_client, monkeypatch,
    ):
        """A handler that kept working on a thread of its own owns the write.
        Marking the command here puts a terminal status in front of the
        progress that handler is still to report - and nothing rewrites a
        status once the progress has landed on top of it."""
        client = self._run(firebase_client, COMMAND_DEFERRED, monkeypatch)
        client._mark_command_completed.assert_not_called()
        client._mark_command_failed.assert_not_called()


@pytest.mark.skipif(
    sys.platform == 'win32', reason='display_manager imports fine on Windows')
class TestDisplayProfileOffWindows:
    """display_manager asserts the Windows x64 ABI while it builds its
    structures, so off Windows the lazy import raises AssertionError rather
    than ImportError - and a guard that caught only ImportError put that
    assertion through every single heartbeat."""

    def test_the_heartbeat_skips_display_enumeration(
        self, firebase_client, monkeypatch, caplog,
    ):
        monkeypatch.delitem(sys.modules, 'display_manager', raising=False)
        firebase_client._cached_display_profile = {'cached': True}

        with caplog.at_level(logging.DEBUG):
            assert firebase_client._ensure_display_profile() == {'cached': True}

        # THE negative control: with `except ImportError` the assertion
        # escapes instead, and the caller logs it as a warning every heartbeat.
        assert 'not available here' in caplog.text
        assert [r for r in caplog.records if r.levelno >= logging.WARNING] == []


# TestSendDisplayAlert — the funnels hand every audit action to
# `send_display_alert`; this gate decides which reach the API. An action with no
# `DISPLAY_EVENT_ROUTING` entry hits the endpoint's generic branch, which writes
# its own log document and duplicates what the agent already logged.
class TestSendDisplayAlert:
    def test_routed_event_is_forwarded(self, firebase_client, monkeypatch):
        send_alert = MagicMock()
        monkeypatch.setattr(firebase_client, 'send_alert', send_alert)
        firebase_client.send_display_alert('display_drift', {'changes': ['refreshHz']})
        send_alert.assert_called_once_with(
            'display_drift', {'changes': ['refreshHz']},
        )

    @pytest.mark.parametrize('event_type', [
        'display_auto_restore_fired',
        'display_apply_acked',
        'display_revert_deferred',
        'display_auto_restore_skipped_unfixable',
        'display_auto_restore_circuit_breaker_tripped',
        'process_crash',
    ])
    def test_unrouted_event_is_dropped(self, firebase_client, monkeypatch, event_type):
        send_alert = MagicMock()
        monkeypatch.setattr(firebase_client, 'send_alert', send_alert)
        firebase_client.send_display_alert(event_type, {'x': 1})
        send_alert.assert_not_called()

    def test_dispatch_failure_is_swallowed(self, firebase_client, monkeypatch):
        # Callers are audit paths that must never break on alert delivery.
        monkeypatch.setattr(
            firebase_client, 'send_alert',
            MagicMock(side_effect=RuntimeError('cannot start thread')),
        )
        firebase_client.send_display_alert('display_sync_lost', {})

    def test_routing_table_parity_with_web(self):
        """`DISPLAY_ALERT_EVENT_TYPES` mirrors `DISPLAY_EVENT_ROUTING`'s keys.

        Different packages, no shared import, so drift is only caught here. Not
        fatal at runtime (unlisted events degrade to log-only) but it is how the
        display alerts went dormant once. Skipped when the web tree is absent.
        """
        import re
        from pathlib import Path

        routing = (
            Path(__file__).resolve().parents[3]
            / 'web' / 'lib' / 'alerts' / 'displayEventRouting.ts'
        )
        if not routing.is_file():
            pytest.skip(f'web routing table not present at {routing}')

        source = routing.read_text(encoding='utf-8')
        body = source.split('DISPLAY_EVENT_ROUTING: Record<string, DisplayEventRoute> = {', 1)[-1]
        web_keys = set(re.findall(r'^  (display_\w+):', body, re.MULTILINE))

        assert web_keys, 'failed to parse DISPLAY_EVENT_ROUTING keys'
        assert web_keys == set(DISPLAY_ALERT_EVENT_TYPES)
