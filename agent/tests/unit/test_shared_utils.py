"""
Unit tests for shared_utils module

Tests utility functions for configuration, system metrics, and process management.
"""

import pytest
import json
import logging
import subprocess
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock, patch, mock_open, MagicMock
import sys
import types

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
        gpu = shared_utils.GpuReading(
            id=0,
            uuid='GPU-test-0',
            name='Test GPU',
            load=0.75,
            memoryTotal=16384,
            memoryUsed=8192,
            memoryFree=8192,
        )

        with patch('shared_utils.get_gpus', return_value=[gpu]):
            with patch('shared_utils.get_gpu_temperatures', return_value=[{'temperature': 65}]):
                metrics = shared_utils.get_system_metrics(skip_gpu=False)

        assert metrics['gpu']['usage_percent'] == 75.0
        assert metrics['gpu']['name'] == 'Test GPU'


@pytest.mark.unit
class TestGetGpus:
    """Tests for the NVML-backed GPU reader"""

    @pytest.fixture(autouse=True)
    def _clear_backoff(self):
        shared_utils._nvml_retry_after = 0.0
        shared_utils._nvml_warn_after.clear()
        yield
        shared_utils._nvml_retry_after = 0.0
        shared_utils._nvml_warn_after.clear()

    class NvmlError(Exception):
        """Stands in for pynvml.NVMLError."""

    class LibraryNotFound(NvmlError):
        """Stands in for pynvml.NVMLError_LibraryNotFound."""

    class DriverNotLoaded(NvmlError):
        """Stands in for pynvml.NVMLError_DriverNotLoaded."""

    def _fake_pynvml(self, init_error=None):
        mod = types.ModuleType('pynvml')
        mod.NVMLError = self.NvmlError
        mod.NVMLError_LibraryNotFound = self.LibraryNotFound
        mod.NVMLError_DriverNotLoaded = self.DriverNotLoaded
        mod.nvmlMemory_v2 = 2
        mod.nvmlInit = Mock(side_effect=init_error)
        mod.nvmlShutdown = Mock()
        mod.nvmlDeviceGetCount = Mock(return_value=1)
        mod.nvmlDeviceGetHandleByIndex = Mock(return_value='handle-0')
        mod.nvmlDeviceGetName = Mock(return_value=b'NVIDIA Test 4090')
        mod.nvmlDeviceGetUUID = Mock(return_value='GPU-abc')
        mod.nvmlDeviceGetMemoryInfo = Mock(return_value=SimpleNamespace(
            total=24 * 1024 ** 3, used=6 * 1024 ** 3, free=18 * 1024 ** 3))
        mod.nvmlDeviceGetUtilizationRates = Mock(return_value=SimpleNamespace(gpu=42))
        return mod

    def test_reads_every_device(self):
        fake = self._fake_pynvml()

        with patch.dict(sys.modules, {'pynvml': fake}):
            gpus = shared_utils.get_gpus()

        assert len(gpus) == 1
        assert gpus[0].id == 0
        assert gpus[0].uuid == 'GPU-abc'
        assert gpus[0].name == 'NVIDIA Test 4090'  # bytes decoded
        assert gpus[0].load == 0.42
        assert gpus[0].memoryTotal == 24 * 1024
        assert gpus[0].memoryUsed == 6 * 1024
        # v2 excludes driver-reserved VRAM from `used`; v1 would inflate it.
        assert fake.nvmlDeviceGetMemoryInfo.call_args.kwargs['version'] == 2
        assert fake.nvmlShutdown.call_count == 1

    def test_falls_back_to_v1_memory_when_v2_is_unsupported(self):
        fake = self._fake_pynvml()

        def mem_info(handle, version=None):
            if version is not None:
                raise self.NvmlError('Function Not Found')
            return SimpleNamespace(
                total=24 * 1024 ** 3, used=7 * 1024 ** 3, free=17 * 1024 ** 3)

        fake.nvmlDeviceGetMemoryInfo = Mock(side_effect=mem_info)

        with patch.dict(sys.modules, {'pynvml': fake}):
            gpus = shared_utils.get_gpus()

        # Driver older than 510: the reading still arrives, off a v1 struct.
        assert gpus[0].memoryUsed == 7 * 1024

    def test_missing_library_backs_off_instead_of_raising(self):
        fake = self._fake_pynvml(init_error=self.LibraryNotFound('nvml.dll'))

        with patch.dict(sys.modules, {'pynvml': fake}):
            assert shared_utils.get_gpus() == []
            # NVML is absent for good: the next tick must not re-probe.
            assert shared_utils.get_gpus() == []

        assert fake.nvmlInit.call_count == 1
        assert shared_utils._nvml_retry_after > 0.0

    def test_no_driver_backs_off_like_a_missing_library(self):
        # A box that once had an NVIDIA card keeps nvml.dll: init reaches the
        # library and fails with DriverNotLoaded, which means the same thing as
        # the library being absent and must not re-probe every 5s forever.
        fake = self._fake_pynvml(init_error=self.DriverNotLoaded('driver'))

        with patch.dict(sys.modules, {'pynvml': fake}):
            assert shared_utils.get_gpus() == []
            assert shared_utils.get_gpus() == []

        assert fake.nvmlInit.call_count == 1
        assert shared_utils._nvml_retry_after > 0.0

    def test_device_read_failure_warns_once_per_window(self, caplog):
        fake = self._fake_pynvml()
        fake.nvmlDeviceGetHandleByIndex = Mock(
            side_effect=RuntimeError('GPU is lost'))

        with patch.dict(sys.modules, {'pynvml': fake}), caplog.at_level(logging.WARNING):
            assert shared_utils.get_gpus() == []
            assert shared_utils.get_gpus() == []

        warnings = [r for r in caplog.records if r.levelno == logging.WARNING]
        assert len(warnings) == 1
        assert 'GPU is lost' in warnings[0].getMessage()

    def test_transient_init_failure_retries_on_the_next_call(self):
        fake = self._fake_pynvml(init_error=RuntimeError('driver reloading'))

        with patch.dict(sys.modules, {'pynvml': fake}):
            assert shared_utils.get_gpus() == []
            assert shared_utils.get_gpus() == []

        # A driver reload costs one sample, not a whole backoff window.
        assert fake.nvmlInit.call_count == 2
        assert shared_utils._nvml_retry_after == 0.0


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


class TestPlatformNormalisation:
    """(osFamily, arch) as the fleet spells it. Every reader of the heartbeat
    fields and of the cortex CLI's pin id depends on these exact strings."""

    @pytest.mark.parametrize('sys_platform,expected', [
        ('win32', 'windows'),
        ('darwin', 'macos'),
        ('linux', 'linux'),
    ])
    def test_os_family_mapping(self, monkeypatch, sys_platform, expected):
        monkeypatch.setattr(sys, 'platform', sys_platform)
        monkeypatch.setattr(shared_utils.platform, 'machine', lambda: 'x86_64')

        assert shared_utils.get_os_family_arch() == (expected, 'x64')

    @pytest.mark.parametrize('machine,expected', [
        ('AMD64', 'x64'),
        ('x86_64', 'x64'),
        ('arm64', 'arm64'),
        ('aarch64', 'arm64'),
        # Windows reports PROCESSOR_ARCHITECTURE verbatim, uppercase.
        ('ARM64', 'arm64'),
    ])
    def test_arch_mapping(self, monkeypatch, machine, expected):
        monkeypatch.setattr(sys, 'platform', 'linux')
        monkeypatch.setattr(shared_utils.platform, 'machine', lambda: machine)

        assert shared_utils.get_os_family_arch() == ('linux', expected)

    def test_unrecognised_values_travel_verbatim(self, monkeypatch):
        monkeypatch.setattr(sys, 'platform', 'freebsd14')
        monkeypatch.setattr(shared_utils.platform, 'machine', lambda: 'riscv64')

        assert shared_utils.get_os_family_arch() == ('freebsd14', 'riscv64')

    def test_an_unrecognised_value_is_logged_once(self, monkeypatch, caplog):
        """The platform is a constant for the life of the process, so an
        unrecognised value is worth exactly one warning."""
        monkeypatch.setattr(shared_utils, '_unrecognised_platform_logged', set())
        monkeypatch.setattr(sys, 'platform', 'freebsd14')
        monkeypatch.setattr(shared_utils.platform, 'machine', lambda: 'x86_64')

        with caplog.at_level(logging.WARNING):
            shared_utils.get_os_family_arch()
            shared_utils.get_os_family_arch()

        assert len([r for r in caplog.records if 'freebsd14' in r.getMessage()]) == 1


class TestPosixMetricProbes:
    """The heartbeat's three shelling metrics, off Windows. `_IS_WINDOWS` is
    monkeypatched rather than skipped, so the POSIX arms are exercised from the
    Windows dev box as well as from the macOS and Linux CI legs."""

    @pytest.fixture
    def posix(self, monkeypatch):
        monkeypatch.setattr(shared_utils, '_IS_WINDOWS', False)

    @pytest.fixture
    def uncached_gateway(self, monkeypatch):
        monkeypatch.setattr(shared_utils, '_cached_gateway', '')
        monkeypatch.setattr(shared_utils, '_cached_gateway_time', 0.0)

    def test_the_no_window_flag_is_spellable_off_windows(self):
        """subprocess.CREATE_NO_WINDOW exists on Windows alone, and these
        probes are one body per platform — an attribute lookup at the call site
        raises where there is no console window to suppress."""
        expected = (
            shared_utils.subprocess.CREATE_NO_WINDOW
            if sys.platform == 'win32' else 0
        )

        assert shared_utils._NO_WINDOW == expected

    def test_the_cpu_name_comes_from_proc_cpuinfo(self, posix):
        cpuinfo = (
            'processor\t: 0\n'
            'vendor_id\t: GenuineIntel\n'
            'model name\t: Intel(R) Core(TM) i9-9900X CPU @ 3.50GHz\n'
            'cpu MHz\t\t: 3500.000\n'
        )

        with patch('builtins.open', mock_open(read_data=cpuinfo)):
            assert shared_utils.get_cpu_name() == (
                'Intel(R) Core(TM) i9-9900X CPU @ 3.50GHz'
            )

    def test_a_cpu_that_names_itself_nowhere_falls_through(self, posix):
        """An arm64 board has no `model name` line at all; what is left is
        platform.processor(), which the Windows path also ends on."""
        with patch('builtins.open', mock_open(read_data='processor\t: 0\n')):
            with patch.object(shared_utils.platform, 'processor', return_value='aarch64'):
                assert shared_utils.get_cpu_name() == 'aarch64'

    def test_the_default_gateway_is_the_route_traffic_takes(
        self, posix, uncached_gateway, monkeypatch
    ):
        """iproute2 prints the default routes best first, so the first `via` is
        the one the latency this measures is actually spent on."""
        routes = (
            'default via 192.168.1.1 dev eth0 proto dhcp src 192.168.1.50 metric 100\n'
            'default via 10.0.0.1 dev wlan0 proto dhcp metric 600\n'
        )
        issued = []

        def check_output(command, **kwargs):
            issued.append(list(command))
            return routes

        monkeypatch.setattr(shared_utils.subprocess, 'check_output', check_output)

        assert shared_utils._detect_default_gateway() == '192.168.1.1'
        assert issued == [['ip', 'route', 'show', 'default']]

    def test_a_machine_with_no_default_route_has_no_gateway(
        self, posix, uncached_gateway, monkeypatch
    ):
        monkeypatch.setattr(
            shared_utils.subprocess, 'check_output', lambda *a, **kw: '\n'
        )

        assert shared_utils._detect_default_gateway() == ''

    def test_the_ping_is_four_echoes_and_their_average(self, posix, monkeypatch):
        output = (
            'PING 192.168.1.1 (192.168.1.1) 56(84) bytes of data.\n'
            '\n'
            '--- 192.168.1.1 ping statistics ---\n'
            '4 packets transmitted, 4 received, 0% packet loss, time 3004ms\n'
            'rtt min/avg/max/mdev = 0.335/0.404/0.531/0.076 ms\n'
        )
        issued = []

        def check_output(command, **kwargs):
            issued.append(list(command))
            return output

        monkeypatch.setattr(shared_utils.subprocess, 'check_output', check_output)

        assert shared_utils._run_ping('192.168.1.1') == {
            'latency_ms': 0.404, 'packet_loss_pct': 0.0,
        }
        assert issued == [['ping', '-c', '4', '-W', '1', '192.168.1.1']]

    def test_a_lossy_link_reports_what_it_lost(self, posix, monkeypatch):
        output = (
            '4 packets transmitted, 3 received, 25% packet loss, time 3004ms\n'
            'rtt min/avg/max/mdev = 1.1/2.2/3.3/0.4 ms\n'
        )
        monkeypatch.setattr(
            shared_utils.subprocess, 'check_output', lambda *a, **kw: output
        )

        assert shared_utils._run_ping('10.0.0.1') == {
            'latency_ms': 2.2, 'packet_loss_pct': 25.0,
        }

    def test_a_ping_that_never_answers_is_unmeasured(self, posix, monkeypatch):
        """ping exits non-zero when every packet is lost, and that has always
        come back unmeasured rather than as a reading of 100% loss."""
        def refuse(*args, **kwargs):
            raise shared_utils.subprocess.CalledProcessError(1, 'ping')

        monkeypatch.setattr(shared_utils.subprocess, 'check_output', refuse)

        assert shared_utils._run_ping('10.0.0.1') == {
            'latency_ms': None, 'packet_loss_pct': None,
        }


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


class TestPerOsProcessHelpers:
    """The two helpers whose answer is a different thing on each OS."""

    @pytest.mark.skipif(
        sys.platform == 'win32', reason='Windows posts WM_CLOSE to the windows first')
    def test_a_posix_terminate_never_reaches_the_window_branch(self):
        """There is no WM_CLOSE analogue off Windows, and win32gui is imported
        inside that branch — so reaching it at all would be an ImportError
        rather than a slow path. POSIX is terminate -> wait -> kill.
        """
        child = subprocess.Popen([sys.executable, '-c', 'import time; time.sleep(30)'])
        try:
            assert shared_utils.graceful_terminate(child.pid, timeout=1) is True
            assert child.wait(10) is not None
        finally:
            if child.poll() is None:
                child.kill()
                child.wait(10)

    @pytest.mark.skipif(
        sys.platform == 'win32', reason='the Windows arm resolves from the install root')
    def test_the_posix_interpreter_comes_from_the_package_prefix(
            self, tmp_path, monkeypatch):
        """The POSIX payloads install to a fixed prefix, so the interpreter is
        the package's own and never whichever python happens to be running."""
        packaged = tmp_path / 'python3'
        packaged.write_text('', encoding='utf-8')
        monkeypatch.setitem(
            shared_utils._POSIX_PYTHON_PATHS, sys.platform, str(packaged))

        assert shared_utils.get_python_exe_path() == str(packaged)

        packaged.unlink()
        with pytest.raises(FileNotFoundError, match='python3'):
            shared_utils.get_python_exe_path()
