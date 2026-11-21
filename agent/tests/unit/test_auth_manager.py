"""Tests for auth_manager.py — OAuth token exchange and refresh logic."""

import pytest
from types import SimpleNamespace
from unittest.mock import MagicMock, patch, PropertyMock
import logging
import time
import json

import osadapter
import secure_storage

try:
    # Patch secure_storage and shared_utils before importing auth_manager —
    # they may need Windows-specific setup.
    mock_storage = MagicMock()
    mock_storage.get_access_token.return_value = (None, None)
    mock_storage.get_site_id.return_value = None
    mock_storage.get_refresh_token.return_value = "mock-refresh-token"
    mock_storage.has_refresh_token.return_value = True
    mock_storage.save_access_token.return_value = True
    mock_storage.save_refresh_token.return_value = True
    mock_storage.save_site_id.return_value = True
    mock_storage.save_credentials.return_value = True

    with patch("secure_storage.get_storage", return_value=mock_storage), \
         patch("secure_storage.SecureStorage", return_value=mock_storage):
        from auth_manager import AuthManager, AuthenticationError, TokenRefreshError, TokenRevokedError
except ImportError:
    pytest.skip("auth_manager not importable", allow_module_level=True)
except Exception as exc:
    pytest.skip(f"auth_manager import failed: {exc}", allow_module_level=True)


@pytest.fixture
def logger():
    return logging.getLogger("test_auth_manager")


@pytest.fixture
def storage():
    """Fresh mock SecureStorage for each test."""
    s = MagicMock()
    s.get_access_token.return_value = (None, None)
    s.get_site_id.return_value = None
    s.get_refresh_token.return_value = "mock-refresh-token"
    s.has_refresh_token.return_value = True
    s.save_access_token.return_value = True
    s.save_refresh_token.return_value = True
    s.save_site_id.return_value = True
    s.save_credentials.return_value = True
    return s


@pytest.fixture
def auth_manager(storage):
    """Create an AuthManager with mocked storage."""
    am = AuthManager(
        api_base="https://owlette.app/api",
        machine_id="TEST-MACHINE",
        storage=storage,
    )
    return am


# TestDeviceCodeCredentials — what a pairing poll must carry before it is stored
class TestDeviceCodeCredentials:
    def test_reply_missing_tokens_is_refused_and_nothing_saved(self, auth_manager, storage):
        """The legacy plaintext poll reply without a refresh token or site."""
        mock_response = MagicMock()
        mock_response.status_code = 200
        mock_response.json.return_value = {"accessToken": "access-123"}

        with patch("requests.post", return_value=mock_response):
            with pytest.raises(AuthenticationError, match="missing tokens"):
                auth_manager.poll_device_code("DEVICE-CODE", interval=0, timeout=5)

        storage.save_credentials.assert_not_called()


# TestPersistCredentials — a pairing's credentials reach the store in one write
class TestPersistCredentials:
    def test_the_store_takes_a_pairing_in_one_write(self, tmp_path, monkeypatch):
        # saved one at a time, a failure part way left one site's refresh
        # token beside another site's id
        monkeypatch.setattr(osadapter, "_adapter", SimpleNamespace(
            key_material=lambda: b"dummy-machine-binding",
            stable_machine_id=lambda: "dummy-machine-binding",
        ))
        store = secure_storage.SecureStorage(config_dir=tmp_path)
        writes = []
        real_write = secure_storage._write_token_file

        def recording_write(path, blob):
            writes.append(blob)
            real_write(path, blob)

        monkeypatch.setattr(secure_storage, "_write_token_file", recording_write)
        am = AuthManager(api_base="https://owlette.app/api", machine_id="TEST-MACHINE", storage=store)

        am._persist_credentials("dummy-access", "dummy-refresh", 3600, "site-a")

        assert len(writes) == 1
        assert json.loads(store._fernet.decrypt(writes[0])) == {
            "refresh_token": "dummy-refresh",
            "access_token": "dummy-access",
            "token_expiry": am._token_expiry,
            "site_id": "site-a",
        }
        assert store.get_move() is None
        assert (am._access_token, am._site_id) == ("dummy-access", "site-a")

    def test_a_failed_save_raises_and_caches_nothing(self, auth_manager, storage):
        storage.save_credentials.return_value = False

        with pytest.raises(AuthenticationError, match="Failed to save tokens"):
            auth_manager._persist_credentials("dummy-access", "dummy-refresh", 3600, "site-a")

        assert (auth_manager._access_token, auth_manager._token_expiry, auth_manager._site_id) == (None, None, None)


# TestMoveCredentials — a site move's writes, serialised with the refreshes
class TestMoveCredentials:
    MOVE = {"moveId": "site-a:TEST-MACHINE", "phase": "switched", "source": "site-a", "target": "site-b"}

    def test_adopting_saves_under_the_refresh_lock_and_caches_the_new_site(self, auth_manager, storage):
        # a refresh in flight would save the old site's rotated refresh token
        # over the new one
        held = []
        storage.save_credentials.side_effect = lambda *args, **kwargs: (
            held.append(auth_manager._refresh_lock.locked()) or True)

        assert auth_manager.adopt_move_credentials(
            "dummy-refresh", "dummy-access", 1234.0, "site-b", self.MOVE) is True

        storage.save_credentials.assert_called_once_with(
            "dummy-refresh", "dummy-access", 1234.0, "site-b", move=self.MOVE)
        assert held == [True]
        assert not auth_manager._refresh_lock.locked()
        assert (auth_manager._access_token, auth_manager._token_expiry, auth_manager.get_site_id()) == (
            "dummy-access", 1234.0, "site-b")

    def test_a_failed_adopt_keeps_the_cache(self, auth_manager, storage):
        auth_manager._access_token, auth_manager._token_expiry, auth_manager._site_id = (
            "dummy-old", 99.0, "site-a")
        storage.save_credentials.return_value = False

        assert auth_manager.adopt_move_credentials(
            "dummy-refresh", "dummy-access", 1234.0, "site-b", self.MOVE) is False

        assert (auth_manager._access_token, auth_manager._token_expiry, auth_manager._site_id) == (
            "dummy-old", 99.0, "site-a")
        assert not auth_manager._refresh_lock.locked()

    def test_finishing_clears_the_move_under_the_refresh_lock(self, auth_manager, storage):
        # the clear rewrites the whole store: a rotated refresh token saved
        # between its read and its write would be lost
        held = []
        storage.clear_move.side_effect = lambda: held.append(auth_manager._refresh_lock.locked()) or True

        assert auth_manager.finish_move() is True

        assert held == [True]
        assert not auth_manager._refresh_lock.locked()

    def test_a_failed_finish_is_reported(self, auth_manager, storage):
        storage.clear_move.return_value = False

        assert auth_manager.finish_move() is False


# TestTokenRefresh — caching and refresh logic
class TestTokenRefresh:
    def test_returns_cached_token_when_valid(self, auth_manager):
        """If the cached token is not expired, return it directly."""
        auth_manager._access_token = "cached-token-abc"
        auth_manager._token_expiry = time.time() + 3600  # Expires in 1 hour

        token = auth_manager.get_valid_token()
        assert token == "cached-token-abc"

    def test_refreshes_when_expired(self, auth_manager, storage):
        """When token is expired, should call refresh endpoint."""
        auth_manager._access_token = "old-token"
        auth_manager._token_expiry = time.time() - 100  # Already expired
        storage.get_refresh_token.return_value = "refresh-token-xyz"

        mock_response = MagicMock()
        mock_response.status_code = 200
        mock_response.json.return_value = {
            "accessToken": "new-token-789",
            "expiresIn": 3600,
        }

        with patch("requests.post", return_value=mock_response):
            token = auth_manager.get_valid_token()

        assert token == "new-token-789"
        assert auth_manager._access_token == "new-token-789"

    def test_refresh_failure_raises(self, auth_manager, storage):
        """If refresh fails, should raise TokenRefreshError."""
        auth_manager._access_token = "old-token"
        auth_manager._token_expiry = time.time() - 1000  # Well past expired
        storage.get_refresh_token.return_value = "refresh-token-xyz"

        with patch("requests.post", side_effect=ConnectionError("offline")):
            with pytest.raises(TokenRefreshError):
                auth_manager.get_valid_token()

    def test_no_token_raises_auth_error(self, auth_manager, storage):
        """If there are no tokens at all, should raise AuthenticationError."""
        auth_manager._access_token = None
        auth_manager._token_expiry = None
        storage.get_access_token.return_value = (None, None)

        with pytest.raises(AuthenticationError):
            auth_manager.get_valid_token()


# TestBackoff — reset on success, exponential growth
class TestBackoff:
    def test_success_resets_failure_count(self, auth_manager, storage):
        """After a successful refresh, failure counters should reset."""
        auth_manager._consecutive_failures = 5
        auth_manager._refresh_backoff_seconds = 480
        auth_manager._access_token = "old"
        auth_manager._token_expiry = time.time() - 100
        storage.get_refresh_token.return_value = "refresh-token"

        mock_response = MagicMock()
        mock_response.status_code = 200
        mock_response.json.return_value = {
            "accessToken": "fresh-token",
            "expiresIn": 3600,
        }

        with patch("requests.post", return_value=mock_response):
            auth_manager.get_valid_token()

        assert auth_manager._consecutive_failures == 0
        assert auth_manager._refresh_backoff_seconds == 60  # Reset to initial

    def test_expired_token_triggers_refresh_call(self, auth_manager, storage):
        """Verify that an expired token triggers refresh rather than returning stale."""
        auth_manager._access_token = "stale-token"
        auth_manager._token_expiry = time.time() - 1  # Just expired
        storage.get_refresh_token.return_value = "refresh-token"

        mock_response = MagicMock()
        mock_response.status_code = 200
        mock_response.json.return_value = {
            "accessToken": "fresh-token",
            "expiresIn": 3600,
        }

        with patch("requests.post", return_value=mock_response) as mock_post:
            token = auth_manager.get_valid_token()

        # Should have made an HTTP call to refresh
        assert mock_post.called
        assert token == "fresh-token"


# TestRefusedRefresh — a 401/403 is the server saying the credential is dead for good
class TestRefusedRefresh:
    @staticmethod
    def _refused(status_code, error):
        response = MagicMock()
        response.status_code = status_code
        response.json.return_value = {"error": error}
        return response

    @pytest.mark.parametrize("status_code", [401, 403])
    def test_the_service_hook_owns_a_refused_refresh(self, storage, status_code):
        # #327: before this hook the store was cleared and the machine stayed
        # paired, syncing on its access token for up to an hour with nothing
        # on the dashboard to show for the revoke.
        reasons = []
        am = AuthManager(
            api_base="https://owlette.app/api",
            machine_id="TEST-MACHINE",
            storage=storage,
            on_revoked=reasons.append,
        )

        with patch("requests.post", return_value=self._refused(status_code, "Invalid refresh token")):
            # a distinct error: the unpair handler tells a refused refresh
            # (the revoke is real) from one it could not ask for
            with pytest.raises(TokenRevokedError):
                am.refresh_now()

        assert reasons == ["the server refused the agent token: Invalid refresh token"]
        # the hook's unpair clears the store itself; a second clear here would
        # race the offline flush the hook sets in motion
        storage.clear_tokens.assert_not_called()

    def test_a_store_emptied_by_another_holder_is_the_same_revoke(self, storage):
        # hoot runs its own AuthManager with no hook and clears the store on
        # its own 401; if it wins that race the service's refresh finds no
        # token, which used to be the pre-fix dead state: paired, no credential
        reasons = []
        storage.get_refresh_token.return_value = None
        # clear_tokens unlinks the store, so a cleared store is one that is gone
        storage.is_cleared.return_value = True
        am = AuthManager(
            api_base="https://owlette.app/api",
            machine_id="TEST-MACHINE",
            storage=storage,
            on_revoked=reasons.append,
        )

        with patch("requests.post") as post:
            with pytest.raises(TokenRevokedError):
                am.refresh_now()

        assert not post.called
        assert reasons == ["no refresh token left in storage"]

    def test_a_store_that_reads_empty_but_is_still_there_is_not_a_revoke(self, storage):
        # a store held open by a scanner, caught mid-replace or damaged reads as
        # no token; unpairing on that takes a site visit to undo, so it is a
        # failed refresh, retried like any other
        reasons = []
        storage.get_refresh_token.return_value = None
        storage.is_cleared.return_value = False
        am = AuthManager(
            api_base="https://owlette.app/api",
            machine_id="TEST-MACHINE",
            storage=storage,
            on_revoked=reasons.append,
        )

        with patch("requests.post") as post:
            with pytest.raises(TokenRefreshError) as raised:
                am.refresh_now()

        assert not isinstance(raised.value, TokenRevokedError)
        assert not post.called
        assert reasons == []
        storage.clear_tokens.assert_not_called()

    def test_without_a_hook_a_refused_refresh_only_clears_the_store(self, auth_manager, storage):
        # the pairing flows and the hoot CLI build an AuthManager with no hook
        with patch("requests.post", return_value=self._refused(401, "Invalid refresh token")):
            with pytest.raises(TokenRefreshError):
                auth_manager.refresh_access_token()

        storage.clear_tokens.assert_called_once()

    def test_a_rate_limited_refresh_is_not_a_revoke(self, storage):
        reasons = []
        am = AuthManager(
            api_base="https://owlette.app/api",
            machine_id="TEST-MACHINE",
            storage=storage,
            on_revoked=reasons.append,
        )

        with patch("requests.post", return_value=self._refused(429, "Too many requests")) as post:
            with pytest.raises(TokenRefreshError) as raised:
                am.refresh_now()

        assert not isinstance(raised.value, TokenRevokedError)
        assert post.called
        assert reasons == []
        storage.clear_tokens.assert_not_called()


# TestRequestDeviceCode - the body the pairing phrase is asked with
class TestRequestDeviceCode:
    def _body(self, auth_manager, **kwargs):
        response = MagicMock()
        response.status_code = 200
        response.json.return_value = {"pairPhrase": "a-b-c"}
        with patch("requests.post", return_value=response) as post:
            auth_manager.request_device_code(**kwargs)
        return post.call_args.kwargs["json"]

    def test_the_body_omits_wants_hoot_by_default(self, auth_manager):
        assert "wantsHoot" not in self._body(auth_manager)

    def test_the_body_carries_wants_hoot_when_asked(self, auth_manager):
        assert self._body(auth_manager, wants_hoot=True)["wantsHoot"] is True


# TestApiBase — every token request goes to api_base
class TestApiBase:
    @pytest.mark.parametrize("api_base", [
        "https://owlette.app/api",
        "https://dev.owlette.app/api/",
    ])
    def test_an_owlette_api_base_is_accepted(self, storage, api_base):
        am = AuthManager(api_base=api_base, machine_id="TEST-MACHINE", storage=storage)
        assert am.api_base == api_base.rstrip("/")

    def test_any_other_api_base_is_refused(self, storage):
        """A refresh token must never be sent to a host outside owlette.app."""
        with pytest.raises(ValueError, match="attacker.example"):
            AuthManager(api_base="https://attacker.example/api", machine_id="TEST-MACHINE", storage=storage)
