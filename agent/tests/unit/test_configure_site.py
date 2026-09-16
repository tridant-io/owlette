"""Tests for configure_site.py pairing flow."""

import re
import sys
from unittest.mock import MagicMock, patch

# No module-level skip guard, deliberately: a broken agent dependency must fail
# collection (pytest exit 2) rather than silently delete these tests behind a
# green run. Unguarded imports are the house norm (test_shared_utils.py:14,
# test_sync_state.py:10, test_command_router.py:8).
import shared_utils
import configure_site

# Patch secure_storage before importing auth_manager since it may require
# Windows-specific setup.
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
    from auth_manager import AuthManager


# The console colours the environment, so every banner assertion reads the
# stripped text.
_ANSI = re.compile(r"\x1b\[[0-9;]*m")

# The two environments the console can name, in _determine_environment's shape.
_PROD = ("production", "https://owlette.app/api", "owlette-prod-90a12")
_DEV = ("development", "https://dev.owlette.app/api", "owlette-dev-3838a")


def _plain(text: str) -> str:
    """Console output with ANSI colour codes stripped."""
    return _ANSI.sub("", text)


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


def _storage():
    storage = MagicMock()
    storage.get_access_token.return_value = (None, None)
    storage.get_site_id.return_value = None
    storage.get_refresh_token.return_value = "mock-refresh-token"
    storage.has_refresh_token.return_value = True
    storage.save_access_token.return_value = True
    storage.save_refresh_token.return_value = True
    storage.save_site_id.return_value = True
    return storage


def _poll_response():
    response = MagicMock()
    response.status_code = 200
    response.json.return_value = {
        "accessToken": "access-123",
        "refreshToken": "refresh-456",
        "expiresIn": 3600,
        "siteId": "site-abc",
    }
    return response


def _interactive_auth_manager():
    auth_manager = MagicMock()
    auth_manager.request_device_code.return_value = {
        "pairPhrase": "admit-nice-stereo",
        "deviceCode": "device-123",
        "verificationUri": "https://owlette.app/add",
        "pairingUrl": "https://owlette.app/add?phrase=admit-nice-stereo",
        "interval": 1,
        "expiresIn": 600,
    }

    def _poll_device_code(*_args, **_kwargs):
        auth_manager._site_id = "site-abc"
        return True

    auth_manager.poll_device_code.side_effect = _poll_device_code
    return auth_manager


def _run_interactive_flow(tmp_path, environment=_PROD, **kwargs):
    auth_manager = _interactive_auth_manager()
    config_path = tmp_path / "config.json"

    with patch("auth_manager.AuthManager", return_value=auth_manager), \
         patch.object(configure_site, "_determine_environment", return_value=environment), \
         patch.object(configure_site, "CONFIG_PATH", config_path), \
         patch.object(configure_site, "_copy_to_clipboard", return_value=True), \
         patch.object(configure_site, "_save_config") as mock_save_config:
        result = configure_site.run_pairing_flow(
            api_base=environment[1],
            show_prompts=True,
            **kwargs,
        )

    return result, auth_manager, mock_save_config


def _run_add_flow(add_phrase="silver-compass-drift"):
    with patch.object(
        configure_site,
        "_determine_environment",
        return_value=_PROD,
    ), \
         patch.object(configure_site, "_save_config"), \
         patch("requests.post", return_value=_poll_response()) as mock_post:
        result = configure_site.run_pairing_flow(
            api_base="https://owlette.app/api",
            add_phrase=add_phrase,
            show_prompts=False,
        )

    return result, mock_post


def test_interactive_prints_the_link_and_polls_with_no_browser_affordance(tmp_path, capsys):
    """There is no local browser any more: phrase, link, environment, polling."""
    result, auth_manager, _save_config = _run_interactive_flow(tmp_path)

    assert result == (True, "Configuration successful", "site-abc")
    auth_manager.poll_device_code.assert_called_once()
    out = _plain(capsys.readouterr().out)
    assert "press Enter" not in out
    assert "https://owlette.app/add" in out
    assert "environment: production (owlette.app)" in out
    assert "this phrase exists only on owlette.app" in out
    assert "waiting for authorization" in out


def test_interactive_names_the_development_environment_it_is_pairing_with(tmp_path, capsys):
    """A dev pairing must say so — naming the wrong server is the field bug."""
    result, _auth_manager, _save_config = _run_interactive_flow(tmp_path, environment=_DEV)

    assert result == (True, "Configuration successful", "site-abc")
    out = _plain(capsys.readouterr().out)
    assert "press Enter" not in out
    assert "environment: development (dev.owlette.app)" in out
    assert "this phrase exists only on dev.owlette.app" in out
    assert "environment: development" in out.split("configuration complete!")[1]


def test_add_poll_includes_machine_id_and_version():
    """The /ADD= poll should identify the agent host and version."""
    auth_manager = MagicMock()
    auth_manager.machine_id = "TEST-MACHINE"
    auth_manager.storage = _storage()

    with patch("auth_manager.AuthManager", return_value=auth_manager):
        result, mock_post = _run_add_flow()

    assert result == (True, "Configuration successful", "site-abc")
    mock_post.assert_called_once()
    payload = mock_post.call_args.kwargs["json"]
    assert payload == {
        "pairPhrase": "silver-compass-drift",
        "machineId": auth_manager.machine_id,
        "version": shared_utils.APP_VERSION,
    }


def test_machine_id_uses_the_persisted_identity(monkeypatch):
    """AuthManager, FirebaseClient, and /ADD= poll should share one identity source."""
    sentinel = "SENTINEL-ID"
    storage = _storage()
    monkeypatch.setattr(shared_utils, "get_machine_id", lambda: sentinel)
    monkeypatch.setattr("auth_manager.get_storage", lambda: storage)

    auth_manager = AuthManager(api_base="https://owlette.app/api", storage=storage)

    patches = {
        name: mock
        for name, mock in _MOCK_MODULES.items()
        if name not in sys.modules
    }
    with patch.dict("sys.modules", patches):
        from firebase_client import FirebaseClient

        firebase_auth = MagicMock(spec=AuthManager)
        firebase_auth.get_valid_token.return_value = "access-123"
        firebase_auth.is_authenticated.return_value = True
        firebase_client = FirebaseClient(
            auth_manager=firebase_auth,
            project_id="test-project",
            site_id="site-abc",
        )

    result, mock_post = _run_add_flow()

    assert result == (True, "Configuration successful", "site-abc")
    assert auth_manager.machine_id == sentinel
    assert firebase_client.machine_id == sentinel
    assert mock_post.call_args.kwargs["json"]["machineId"] == sentinel
