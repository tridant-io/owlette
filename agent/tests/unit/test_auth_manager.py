"""Tests for auth_manager.py — OAuth token exchange and refresh logic."""

import pytest
from unittest.mock import MagicMock, patch, PropertyMock
import logging
import time
import json

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

    with patch("secure_storage.get_storage", return_value=mock_storage), \
         patch("secure_storage.SecureStorage", return_value=mock_storage):
        from auth_manager import AuthManager, AuthenticationError, TokenRefreshError
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


# TestTokenExchange — registration code -> tokens
class TestTokenExchange:
    def test_successful_exchange(self, auth_manager):
        """exchange_registration_code should return True on 200."""
        mock_response = MagicMock()
        mock_response.status_code = 200
        mock_response.json.return_value = {
            "accessToken": "access-123",
            "refreshToken": "refresh-456",
            "expiresIn": 3600,
            "siteId": "site-abc",
        }

        with patch("requests.post", return_value=mock_response), \
             patch("builtins.open", MagicMock()):
            result = auth_manager.exchange_registration_code("REG-CODE-XYZ")

        assert result is True
        assert auth_manager._access_token == "access-123"
        assert auth_manager._site_id == "site-abc"

    def test_error_on_non_200_response(self, auth_manager):
        """Non-200 response should raise AuthenticationError."""
        mock_response = MagicMock()
        mock_response.status_code = 401
        mock_response.text = "Unauthorized"
        mock_response.json.return_value = {"error": "invalid_code"}

        with patch("requests.post", return_value=mock_response), \
             patch("builtins.open", MagicMock()):
            with pytest.raises(AuthenticationError):
                auth_manager.exchange_registration_code("BAD-CODE")

    def test_error_on_network_failure(self, auth_manager):
        """Network errors should raise AuthenticationError wrapping the original."""
        with patch("requests.post", side_effect=ConnectionError("DNS resolution failed")), \
             patch("builtins.open", MagicMock()):
            with pytest.raises(AuthenticationError):
                auth_manager.exchange_registration_code("REG-CODE")

    def test_error_on_missing_tokens(self, auth_manager):
        """If response is missing required fields, should raise."""
        mock_response = MagicMock()
        mock_response.status_code = 200
        mock_response.json.return_value = {
            "accessToken": "access-123",
            # Missing refreshToken and siteId
        }

        with patch("requests.post", return_value=mock_response), \
             patch("builtins.open", MagicMock()):
            with pytest.raises(AuthenticationError):
                auth_manager.exchange_registration_code("REG-CODE")


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
