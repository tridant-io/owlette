"""Swoop follows the Firebase client it mints and audits with.

A dashboard remove followed by an in-place re-pair restarts the client; the
swoop manager and doorbell built on the old one then served every session
request with a dead token and no doorbell until the next service restart
(elm-fort, 2026-10-14, eleven hours). ``_restart_swoop`` runs after every
client (re)start and rebuilds the pair on the client the service now has.
"""

import threading
from types import SimpleNamespace
from unittest.mock import MagicMock, patch

from owlette_service import OwletteService


def _bind(svc, name):
    return getattr(OwletteService, name).__get__(svc, OwletteService)


class FakeDoorbell:
    """Records what the service built it with; ``start`` is the mint it would make."""

    built = []

    def __init__(self, *, on_ring, get_agent_token, shutdown_event, is_connected, on_enabled):
        self.get_agent_token = get_agent_token
        self.shutdown_event = shutdown_event
        self.started = False
        FakeDoorbell.built.append(self)

    def start(self):
        self.started = True

    def refresh_now(self):
        pass


class FakeManager:
    built = []

    def __init__(self, *, firebase_client, on_refresh):
        self.firebase_client = firebase_client
        self.kills = []
        FakeManager.built.append(self)

    def kill(self, reason):
        self.kills.append(reason)


def _client():
    client = MagicMock()
    client.auth_manager.get_valid_token = MagicMock(name='get_valid_token')
    return client


def _service(client):
    """The service's swoop state as __init__ leaves it, bound to the real methods."""
    svc = SimpleNamespace(
        firebase_client=client,
        swoop_manager=None,
        swoop_doorbell=None,
        _swoop_shutdown=threading.Event(),
    )
    for name in ('_start_swoop', '_stop_swoop', '_restart_swoop'):
        setattr(svc, name, _bind(svc, name))
    return svc


class TestRestartSwoop:
    def setup_method(self):
        FakeDoorbell.built = []
        FakeManager.built = []
        self.patches = [
            patch('swoop_doorbell.SwoopDoorbell', FakeDoorbell),
            patch('swoop_manager.SwoopManager', FakeManager),
        ]
        for p in self.patches:
            p.start()

    def teardown_method(self):
        for p in self.patches:
            p.stop()

    def test_the_rebuilt_pair_mints_and_audits_with_the_new_client(self):
        old_client, new_client = _client(), _client()
        svc = _service(old_client)
        svc._start_swoop()
        old_manager, old_doorbell, old_event = svc.swoop_manager, svc.swoop_doorbell, svc._swoop_shutdown

        svc.firebase_client = new_client
        svc._restart_swoop()

        # the old pair is ended: its streamer killed, its doorbell's event set
        assert old_manager.kills == ['service_stop']
        assert old_event.is_set()
        assert old_doorbell.shutdown_event is old_event
        # and the new pair mints and audits with the client the service has now
        assert svc.swoop_manager is not old_manager
        assert svc.swoop_manager.firebase_client is new_client
        assert svc.swoop_doorbell is not old_doorbell
        assert svc.swoop_doorbell.get_agent_token is new_client.auth_manager.get_valid_token
        assert svc.swoop_doorbell.started
        assert svc._swoop_shutdown is not old_event
        assert not svc._swoop_shutdown.is_set()

    def test_a_first_start_only_builds(self):
        svc = _service(_client())

        svc._restart_swoop()

        assert len(FakeManager.built) == 1 and len(FakeDoorbell.built) == 1
        assert svc.swoop_doorbell.started
        assert not svc._swoop_shutdown.is_set()


class TestClientReinitRebuildsSwoop:
    """The call site: a successful client (re)start rebuilds swoop, a failed
    one does not."""

    def _service(self):
        order = []
        svc = SimpleNamespace(
            firebase_client=None,
            _cached_site_timezone=None,
            handle_firebase_command=MagicMock(),
            handle_config_update=MagicMock(),
            _on_removed_from_site=MagicMock(),
            _wire_connection_status_listener=lambda: order.append('wire'),
            _update_health_state=MagicMock(),
            _handle_watchdog_restart=MagicMock(),
            _restart_swoop=lambda: order.append('restart_swoop'),
            unpair=MagicMock(),
        )
        svc._initialize_or_restart_firebase_client = _bind(
            svc, '_initialize_or_restart_firebase_client')
        return svc, order

    @staticmethod
    def _config(path):
        return {
            ('firebase', 'enabled'): True,
            ('firebase', 'site_id'): 'site_1',
            ('firebase', 'project_id'): 'proj',
        }.get(tuple(path))

    def _patched(self, client, auth):
        return [
            patch('owlette_service.FIREBASE_AVAILABLE', True),
            patch('owlette_service.FirebaseClient', return_value=client),
            patch('auth_manager.AuthManager', return_value=auth),
            patch('owlette_service.shared_utils.read_config', side_effect=self._config),
            patch('owlette_service.shared_utils.get_configured_api_base', return_value='https://x'),
            patch('owlette_service.shared_utils.get_data_path', return_value='cache.json'),
        ]

    def test_swoop_is_rebuilt_after_the_new_client_starts(self):
        svc, order = self._service()
        client = MagicMock()
        client.start.side_effect = lambda: order.append('client_start')
        client.site_timezone = 'UTC'
        auth = MagicMock()
        auth.is_authenticated.return_value = True

        patches = self._patched(client, auth)
        for p in patches:
            p.start()
        try:
            assert svc._initialize_or_restart_firebase_client() is True
        finally:
            for p in patches:
                p.stop()

        assert order == ['wire', 'client_start', 'restart_swoop']
        assert svc.firebase_client is client

    def test_a_client_that_fails_to_start_leaves_swoop_alone(self):
        svc, order = self._service()
        client = MagicMock()
        client.start.side_effect = RuntimeError('no network')
        auth = MagicMock()
        auth.is_authenticated.return_value = True

        patches = self._patched(client, auth)
        for p in patches:
            p.start()
        try:
            assert svc._initialize_or_restart_firebase_client() is False
        finally:
            for p in patches:
                p.stop()

        assert 'restart_swoop' not in order
