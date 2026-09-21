"""
Unit tests for shared_utils module

Tests utility functions for configuration, system metrics, and process management.
"""

import pytest
import json
import logging
import re
from pathlib import Path
from unittest.mock import Mock, patch, mock_open, MagicMock
import sys

# Import the module under test
import shared_utils


class TestConfigManagement:
    """Tests for configuration file management"""

    def test_read_config_file_exists(self, mock_config):
        """Test reading configuration when file exists"""
        config_json = json.dumps(mock_config)

        with patch('builtins.open', mock_open(read_data=config_json)):
            with patch('os.path.exists', return_value=True):
                result = shared_utils.read_config()

                assert result is not None
                assert result['firebase']['site_id'] == 'test-site'
                assert len(result['processes']) == 1

    def test_read_config_file_missing(self):
        """Test reading configuration when file doesn't exist"""
        # Bypass the mtime-based config cache by making getmtime raise.
        # _read_config_cached() falls through to the raw reader in that case.
        with patch('os.path.getmtime', side_effect=OSError):
            with patch('builtins.open', side_effect=FileNotFoundError):
                result = shared_utils.read_config()

                assert result == {}

    def test_read_config_invalid_json(self):
        """Test reading configuration with invalid JSON"""
        with patch('os.path.getmtime', side_effect=OSError):
            with patch('builtins.open', mock_open(read_data='invalid json{')):
                result = shared_utils.read_config()

                assert result == {}

    def test_read_config_specific_keys(self, mock_config):
        """Test reading specific keys from configuration"""
        config_json = json.dumps(mock_config)

        with patch('builtins.open', mock_open(read_data=config_json)):
            with patch('os.path.exists', return_value=True):
                # Read specific keys
                processes = shared_utils.read_config(['processes'])

                assert isinstance(processes, list)
                assert len(processes) == 1
                assert processes[0]['name'] == 'Test Process'

    def test_write_config_success(self, mock_config):
        """Test writing configuration successfully"""
        config_json = json.dumps(mock_config)
        with patch('builtins.open', mock_open(read_data=config_json)):
            with patch('os.replace'):
                # write_config takes (keys, value) and updates a nested key
                shared_utils.write_config(['logging', 'level'], 'DEBUG')

    def test_write_config_failure(self, mock_config):
        """Test writing configuration when file cannot be read"""
        with patch('builtins.open', side_effect=IOError("Cannot write file")):
            # write_config should not raise — write_json_to_file handles errors
            try:
                shared_utils.write_config(['logging', 'level'], 'DEBUG')
            except (IOError, OSError):
                pass  # Expected when file operations fail


class TestWriteConfig:
    """write_config used to walk missing intermediates with item.get(key, {}),
    landing the write in a detached dict and reporting success — a silent no-op
    on any path the config had not grown yet."""

    @pytest.fixture
    def config_file(self, tmp_path, monkeypatch):
        path = tmp_path / 'config.json'
        path.write_text(json.dumps({
            'firebase': {'enabled': True, 'site_id': 'test-site'},
            'displays': {'autoRestore': {'enabled': True}},
        }))
        monkeypatch.setattr(shared_utils, 'CONFIG_PATH', str(path))
        shared_utils._invalidate_config_cache()
        return path

    def _read(self, path):
        return json.loads(path.read_text())

    def test_a_write_into_a_missing_intermediate_lands(self, config_file):
        shared_utils.write_config(['cortex', 'apiKeyEncrypted'], 'blob')

        assert self._read(config_file)['cortex'] == {'apiKeyEncrypted': 'blob'}

    def test_every_missing_level_of_a_deep_path_is_created(self, config_file):
        shared_utils.write_config(
            ['displays', 'autoRestore', 'circuitBreaker', 'failures'], 2)

        autorestore = self._read(config_file)['displays']['autoRestore']
        assert autorestore['circuitBreaker'] == {'failures': 2}
        assert autorestore['enabled'] is True  # sibling untouched

    def test_an_existing_path_is_updated_without_touching_siblings(self, config_file):
        shared_utils.write_config(['firebase', 'site_id'], 'other-site')

        firebase = self._read(config_file)['firebase']
        assert firebase['site_id'] == 'other-site'
        assert firebase['enabled'] is True

    def test_a_top_level_key_is_written(self, config_file):
        shared_utils.write_config(['environment'], 'dev')

        assert self._read(config_file)['environment'] == 'dev'

    def test_a_scalar_intermediate_raises_rather_than_clobbering_it(self, config_file):
        # Making room for the write would mean replacing the string with a dict
        # and destroying whatever it held; failing loudly is the safe answer.
        with pytest.raises(ValueError) as excinfo:
            shared_utils.write_config(['firebase', 'site_id', 'nested'], 'x')

        assert 'firebase.site_id' in str(excinfo.value)
        assert self._read(config_file)['firebase']['site_id'] == 'test-site'

    def test_the_new_value_is_published_to_the_read_cache(self, config_file):
        shared_utils.write_config(['cortex', 'enabled'], True)

        # No mtime wait: in-process readers must see it immediately.
        assert shared_utils.read_config(['cortex', 'enabled']) is True


class TestSystemMetrics:
    """Tests for system metrics collection"""

    def test_get_system_metrics_basic(self):
        """Test basic system metrics collection returns expected keys"""
        metrics = shared_utils.get_system_metrics(skip_gpu=True)

        assert 'cpu' in metrics
        assert 'percent' in metrics['cpu']
        assert 'memory' in metrics
        assert 'percent' in metrics['memory']
        assert 'disk' in metrics
        assert 'percent' in metrics['disk']

    def test_get_system_metrics_with_gpu(self):
        """Test system metrics collection includes GPU section"""
        mock_gpu = Mock()
        mock_gpu.load = 0.75
        mock_gpu.memoryUsed = 8192  # MB
        mock_gpu.memoryTotal = 16384  # MB
        mock_gpu.name = "Test GPU"
        mock_gpu.temperature = 65

        # GPUtil is now lazy-loaded via _get_gputil(). Return a fake module
        # whose getGPUs() returns our mock GPU object.
        fake_gputil_module = Mock()
        fake_gputil_module.getGPUs = Mock(return_value=[mock_gpu])

        with patch('shared_utils._get_gputil', return_value=fake_gputil_module):
            with patch('shared_utils.get_gpu_temperatures', return_value=[{'temperature': 65}]):
                metrics = shared_utils.get_system_metrics(skip_gpu=False)

        assert metrics['gpu']['usage_percent'] == 75.0
        assert metrics['gpu']['name'] == 'Test GPU'


class TestProcessUtils:
    """Tests for process utility functions"""

    def test_is_process_responsive_windows(self):
        """Test process responsiveness check (Windows-specific)"""
        # This test should be marked as Windows-only
        pytest.skip("Windows-specific test - requires win32gui")

    @patch('psutil.Process')
    def test_get_process_info(self, mock_process):
        """Test getting process information"""
        mock_proc = Mock()
        mock_proc.pid = 12345
        mock_proc.name.return_value = "test.exe"
        mock_proc.status.return_value = "running"
        mock_process.return_value = mock_proc

        info = {
            'pid': mock_proc.pid,
            'name': mock_proc.name(),
            'status': mock_proc.status()
        }

        assert info['pid'] == 12345
        assert info['name'] == "test.exe"
        assert info['status'] == "running"


@pytest.mark.unit
class TestUtilityFunctions:
    """Tests for misc utility functions"""

    def test_get_timestamp(self):
        """Test timestamp generation"""
        timestamp = shared_utils.get_timestamp() if hasattr(shared_utils, 'get_timestamp') else None

        if timestamp:
            assert isinstance(timestamp, (int, float))
            assert timestamp > 0

    def test_format_bytes(self):
        """Test byte formatting"""
        if hasattr(shared_utils, 'format_bytes'):
            assert shared_utils.format_bytes(1024) == "1.0 KB"
            assert shared_utils.format_bytes(1024 * 1024) == "1.0 MB"
            assert shared_utils.format_bytes(1024 * 1024 * 1024) == "1.0 GB"


class TestEnvironmentAccessors:
    """the only four functions allowed to hold a dev/prod literal on the
    python side — pin the exact strings every caller resolves through them."""

    def test_web_host_development(self):
        assert shared_utils.get_web_host('development') == 'dev.owlette.app'

    def test_web_host_production(self):
        assert shared_utils.get_web_host('production') == 'owlette.app'

    def test_environment_label_development(self):
        assert shared_utils.get_environment_label('development') == 'development (dev.owlette.app)'

    def test_environment_label_production(self):
        assert shared_utils.get_environment_label('production') == 'production (owlette.app)'

    def test_api_base_url_development(self):
        assert shared_utils.get_api_base_url('development') == 'https://dev.owlette.app/api'

    def test_api_base_url_production(self):
        assert shared_utils.get_api_base_url('production') == 'https://owlette.app/api'

    def test_project_id_development(self):
        assert shared_utils.get_project_id('development') == 'owlette-dev-3838a'

    def test_project_id_production(self):
        assert shared_utils.get_project_id('production') == 'owlette-prod-90a12'

    def test_unrecognised_environment_falls_through_to_production(self):
        # only 'development' is special-cased; anything else must resolve to
        # prod rather than to a half-configured dev target.
        assert shared_utils.get_web_host('staging') == 'owlette.app'
        assert shared_utils.get_environment_label('staging') == 'staging (owlette.app)'
        assert shared_utils.get_api_base_url('staging') == 'https://owlette.app/api'
        assert shared_utils.get_project_id('staging') == 'owlette-prod-90a12'


# a raw read of firebase.api_base that skips get_configured_api_base
_RAW_API_BASE_READ = re.compile(
    r"""\.get\(\s*['"]api_base['"]"""
    r"""|['"]firebase['"]\s*,\s*['"]api_base['"]"""
    r"""|\[\s*['"]api_base['"]\s*\](?!\s*=)"""
)


class TestConfiguredApiBase:
    """config.json is writable by local users, so firebase.api_base must never
    send this machine's credentials anywhere but the two owlette API bases."""

    @pytest.mark.parametrize('api_base', [
        'https://owlette.app/api',
        'https://dev.owlette.app/api',
    ])
    def test_an_owlette_api_base_is_used_as_configured(self, api_base):
        config = {'environment': 'production', 'firebase': {'api_base': api_base}}
        assert shared_utils.is_owlette_api_base(api_base)
        assert shared_utils.get_configured_api_base(config) == api_base

    @pytest.mark.parametrize('api_base', [
        'https://attacker.example/api',
        'https://owlette.app.attacker.example/api',
        'https://owlette.app@attacker.example/api',
        'https://owlette.app:8443/api',
        'http://owlette.app/api',
        'http://localhost:3000/api',
    ])
    def test_any_other_value_is_replaced_by_the_environment_base(self, api_base, caplog):
        config = {'environment': 'development', 'firebase': {'api_base': api_base}}

        with caplog.at_level(logging.WARNING):
            resolved = shared_utils.get_configured_api_base(config)

        assert not shared_utils.is_owlette_api_base(api_base)
        assert resolved == 'https://dev.owlette.app/api'
        assert api_base in caplog.text

    def test_a_missing_api_base_is_the_environment_base_without_a_warning(self, caplog):
        with caplog.at_level(logging.WARNING):
            resolved = shared_utils.get_configured_api_base({'environment': 'production', 'firebase': {}})

        assert resolved == 'https://owlette.app/api'
        assert caplog.text == ''

    def test_reads_the_config_on_disk_by_default(self):
        config = {'environment': 'production', 'firebase': {'api_base': 'https://attacker.example/api'}}
        with patch.object(shared_utils, 'read_config', return_value=config):
            assert shared_utils.get_configured_api_base() == 'https://owlette.app/api'

    def test_no_other_module_reads_firebase_api_base_itself(self):
        # a raw read would bypass the check above; configure_site's write is allowed
        src = Path(shared_utils.__file__).parent
        offenders = [
            f"{path.name}:{lineno}"
            for path in sorted(src.glob('*.py')) if path.name != 'shared_utils.py'
            for lineno, line in enumerate(path.read_text(encoding='utf-8').splitlines(), start=1)
            if _RAW_API_BASE_READ.search(line)
        ]
        assert offenders == []


# ─── external log rotation ───────────────────────────────────────────


class TestRotateLogIfOversized:
    """
    guards the installer's /LOG file, which Inno Setup appends to forever and
    which cleanup_old_logs never ages out (each update refreshes its mtime).
    """

    def test_small_log_is_left_alone(self, tmp_path):
        log = tmp_path / 'installer_update.log'
        log.write_bytes(b'x' * 100)

        assert shared_utils.rotate_log_if_oversized(str(log), max_bytes=1024) is False
        assert log.read_bytes() == b'x' * 100
        assert not (tmp_path / 'installer_update.log.1').exists()

    def test_oversized_log_is_rotated_once(self, tmp_path):
        log = tmp_path / 'installer_update.log'
        log.write_bytes(b'x' * 4096)

        assert shared_utils.rotate_log_if_oversized(str(log), max_bytes=1024) is True
        assert not log.exists()  # next writer starts from empty
        assert (tmp_path / 'installer_update.log.1').read_bytes() == b'x' * 4096

    def test_rotation_keeps_exactly_one_generation(self, tmp_path):
        """a second rotation replaces .1 — no growing .1/.2/.3 chain."""
        log = tmp_path / 'installer_update.log'
        rotated = tmp_path / 'installer_update.log.1'

        log.write_bytes(b'first' * 1000)
        shared_utils.rotate_log_if_oversized(str(log), max_bytes=1024)
        log.write_bytes(b'second' * 1000)
        shared_utils.rotate_log_if_oversized(str(log), max_bytes=1024)

        assert rotated.read_bytes() == b'second' * 1000
        assert not (tmp_path / 'installer_update.log.2').exists()

    def test_missing_log_is_not_an_error(self, tmp_path):
        assert shared_utils.rotate_log_if_oversized(
            str(tmp_path / 'never-written.log')
        ) is False

    def test_failure_never_raises(self, tmp_path, monkeypatch):
        """an update must not fail because its log could not be rotated."""
        log = tmp_path / 'installer_update.log'
        log.write_bytes(b'x' * 4096)

        def _boom(*a, **kw):
            raise OSError('file locked by the installer')

        monkeypatch.setattr(shared_utils.os, 'replace', _boom)
        assert shared_utils.rotate_log_if_oversized(str(log), max_bytes=1024) is False
        assert log.exists()


class TestWriteJsonToFileLocks:
    """A target held open without delete sharing cannot be replaced. A
    single-attempt caller (the service's 5-second status write) tries again on
    its own next tick, so that lock is debug; a multi-attempt call still
    reports it at error once its retries run out."""

    @staticmethod
    def _hold(path):
        import win32file
        return win32file.CreateFile(
            str(path), win32file.GENERIC_READ,
            win32file.FILE_SHARE_READ | win32file.FILE_SHARE_WRITE,
            None, win32file.OPEN_EXISTING, 0, None)

    @staticmethod
    def _lock_records(caplog):
        return [r for r in caplog.records if 'ile locked' in r.getMessage()]

    def test_a_single_attempt_lock_logs_debug_and_never_error(
            self, tmp_path, monkeypatch, caplog):
        import logging
        target = tmp_path / 'service_status.json'
        target.write_text('{}')
        sleeps = []
        monkeypatch.setattr(shared_utils.time, 'sleep', sleeps.append)

        held = self._hold(target)
        try:
            with caplog.at_level(logging.DEBUG):
                shared_utils.write_json_to_file({'a': 1}, str(target), max_retries=1)
        finally:
            held.Close()

        assert [r.levelno for r in self._lock_records(caplog)] == [logging.DEBUG]
        assert not [r for r in caplog.records if r.levelno >= logging.WARNING]
        assert sleeps == []
        assert json.loads(target.read_text()) == {}
        assert not (tmp_path / 'service_status.json.tmp').exists()

    def test_a_multi_attempt_lock_still_logs_error_after_the_last_retry(
            self, tmp_path, monkeypatch, caplog):
        import logging
        target = tmp_path / 'app_states.json'
        target.write_text('{}')
        sleeps = []
        monkeypatch.setattr(shared_utils.time, 'sleep', sleeps.append)

        held = self._hold(target)
        try:
            with caplog.at_level(logging.DEBUG):
                shared_utils.write_json_to_file({'a': 1}, str(target))
        finally:
            held.Close()

        assert [r.levelno for r in self._lock_records(caplog)] == [
            logging.WARNING, logging.WARNING, logging.ERROR]
        assert sleeps == [0.1, 0.2]
        assert json.loads(target.read_text()) == {}
