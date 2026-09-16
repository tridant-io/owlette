"""
Pytest Configuration and Shared Fixtures

This file contains shared fixtures and configuration for all tests.
"""

import os
import pytest
import shutil
import sys
import tempfile
from pathlib import Path
from unittest.mock import Mock, MagicMock

# Add src directory to path so tests can import modules
src_path = Path(__file__).parent.parent / 'src'
sys.path.insert(0, str(src_path))

# Sandbox the agent data root for the whole run, here rather than in a fixture:
# shared_utils freezes CONFIG_PATH and its siblings off the root at import, and
# test modules are imported before any fixture runs. Modules resolve paths under
# the root while merely being constructed — the persisted machine identity among
# them — so without this a test that forgets a stub writes into
# %PROGRAMDATA%\Owlette and can re-key the agent paired on the machine running
# the suite.
_OWNED_DATA_ROOT = None
if not os.environ.get('OWLETTE_DATA_ROOT'):
    _OWNED_DATA_ROOT = tempfile.mkdtemp(prefix='owlette-tests-')
    os.environ['OWLETTE_DATA_ROOT'] = _OWNED_DATA_ROOT


def pytest_sessionfinish(session, exitstatus):
    """Remove the sandboxed data root, if this run is the one that made it."""
    if _OWNED_DATA_ROOT:
        shutil.rmtree(_OWNED_DATA_ROOT, ignore_errors=True)


@pytest.fixture(scope='session', autouse=True)
def _macos_tmp_is_an_extract_root(tmp_path_factory):
    """Let the suite's own temp tree serve as a roost extract root on macOS.

    pytest hands out `tmp_path` under `/private/var/folders`, which
    destination_allowlist refuses as a macOS system path — correctly, and that
    is shipped policy. The carve-out belongs to the tests, so it is injected
    here for this session's base temp only and never to the shipped table.
    """
    if sys.platform != 'darwin':
        yield
        return

    import destination_allowlist

    base = tmp_path_factory.getbasetemp()
    original = destination_allowlist._POSIX_SYSTEM_PATH_EXCEPTIONS['macos']
    destination_allowlist._POSIX_SYSTEM_PATH_EXCEPTIONS['macos'] = original | {
        str(base), str(base.resolve()),
    }
    try:
        yield
    finally:
        destination_allowlist._POSIX_SYSTEM_PATH_EXCEPTIONS['macos'] = original


@pytest.fixture
def mock_firebase_credentials():
    """Mock Firebase service account credentials"""
    return {
        "type": "service_account",
        "project_id": "test-project",
        "private_key_id": "test-key-id",
        "private_key": "-----BEGIN PRIVATE KEY-----\ntest-key\n-----END PRIVATE KEY-----\n",
        "client_email": "test@test-project.iam.gserviceaccount.com",
        "client_id": "123456789",
        "auth_uri": "https://accounts.google.com/o/oauth2/auth",
        "token_uri": "https://oauth2.googleapis.com/token",
        "auth_provider_x509_cert_url": "https://www.googleapis.com/oauth2/v1/certs"
    }


@pytest.fixture
def mock_config():
    """Mock configuration dict"""
    return {
        "firebase": {
            "enabled": True,
            "site_id": "test-site"
        },
        "processes": [
            {
                "id": "test-process-1",
                "name": "Test Process",
                "exe_path": "C:\\test\\app.exe",
                "file_path": "",
                "cwd": "C:\\test",
                "autolaunch": True,
                "priority": "Normal",
                "visibility": "Show",
                "time_delay": "0",
                "time_to_init": "10",
                "relaunch_attempts": "3"
            }
        ]
    }


@pytest.fixture
def mock_firestore_db():
    """Mock Firestore database client"""
    mock_db = MagicMock()

    # Mock collection/document chain
    mock_db.collection.return_value = MagicMock()
    mock_db.collection().document.return_value = MagicMock()

    return mock_db


@pytest.fixture
def mock_firebase_app():
    """Mock Firebase app instance"""
    return MagicMock()


@pytest.fixture
def mock_system_metrics():
    """Mock system metrics data"""
    return {
        'cpu': {
            'percent': 45.5,
            'count': 8
        },
        'memory': {
            'percent': 60.0,
            'used_gb': 12.5,
            'total_gb': 32.0
        },
        'disk': {
            'percent': 70.0,
            'used_gb': 350.0,
            'total_gb': 500.0
        },
        'gpu': {
            'percent': 0.0,
            'memory_percent': 0.0
        },
        'processes': {
            'test-process-1': {
                'name': 'Test Process',
                'status': 'RUNNING',
                'pid': 12345,
                'responsive': True,
                'last_updated': 1234567890
            }
        }
    }


@pytest.fixture(autouse=True)
def reset_environment(monkeypatch):
    """Reset environment variables before each test"""
    # This fixture automatically runs before each test
    # Add any environment cleanup here if needed
    yield
    # Cleanup after test
    pass


@pytest.fixture(autouse=True)
def _invalidate_shared_utils_caches():
    """Reset shared_utils caches before each test.

    shared_utils has an mtime-based config cache and a TTL cache for
    is_script_running(). These can cause cross-test pollution where a
    mocked file-read in one test contaminates a "file missing" test
    in another. Clear both before each test runs.
    """
    try:
        import shared_utils
        if hasattr(shared_utils, '_invalidate_config_cache'):
            shared_utils._invalidate_config_cache()
        if hasattr(shared_utils, '_script_running_cache'):
            shared_utils._script_running_cache.clear()
    except ImportError:
        pass
    yield


# Platform-specific markers
def pytest_configure(config):
    """Configure custom markers"""
    config.addinivalue_line(
        "markers", "windows: mark test as Windows-only"
    )
    config.addinivalue_line(
        "markers", "unit: mark test as a unit test"
    )
    config.addinivalue_line(
        "markers", "integration: mark test as an integration test"
    )


def pytest_collection_modifyitems(config, items):
    """Skip @pytest.mark.windows tests when not running on Windows.

    The marker carries its own reason when the test has one to give
    (@pytest.mark.windows(reason='...')); otherwise the skip reads
    'windows-only'.
    """
    if sys.platform == 'win32':
        return

    for item in items:
        marker = item.get_closest_marker('windows')
        if marker is None:
            continue
        item.add_marker(pytest.mark.skip(reason=marker.kwargs.get('reason', 'windows-only')))
