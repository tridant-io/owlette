"""
Unit tests for shared_utils module

Tests utility functions for configuration, system metrics, and process management.
"""

import psutil
import pytest
import json
import logging
import plistlib
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
    """The heartbeat's three shelling metrics, off Windows. The platform flags
    are monkeypatched rather than skipped, so both POSIX arms are exercised
    from the Windows dev box as well as from the macOS and Linux CI legs — and
    each against its own mechanism, since macOS ships neither /proc nor
    iproute2 and its ping counts `-W` in milliseconds."""

    @pytest.fixture
    def linux(self, monkeypatch):
        monkeypatch.setattr(shared_utils, '_IS_WINDOWS', False)
        monkeypatch.setattr(shared_utils, '_IS_MACOS', False)

    @pytest.fixture
    def macos(self, monkeypatch):
        monkeypatch.setattr(shared_utils, '_IS_WINDOWS', False)
        monkeypatch.setattr(shared_utils, '_IS_MACOS', True)

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

    def test_the_cpu_name_comes_from_proc_cpuinfo(self, linux):
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

    def test_a_cpu_that_names_itself_nowhere_falls_through(self, linux):
        """An arm64 board has no `model name` line at all; what is left is
        platform.processor(), which the Windows path also ends on."""
        with patch('builtins.open', mock_open(read_data='processor\t: 0\n')):
            with patch.object(shared_utils.platform, 'processor', return_value='aarch64'):
                assert shared_utils.get_cpu_name() == 'aarch64'

    def test_the_default_gateway_is_the_route_traffic_takes(
        self, linux, uncached_gateway, monkeypatch
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
        self, linux, uncached_gateway, monkeypatch
    ):
        monkeypatch.setattr(
            shared_utils.subprocess, 'check_output', lambda *a, **kw: '\n'
        )

        assert shared_utils._detect_default_gateway() == ''

    def test_the_ping_is_four_echoes_and_their_average(self, linux, monkeypatch):
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

    def test_a_lossy_link_reports_what_it_lost(self, linux, monkeypatch):
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

    def test_the_cpu_name_comes_from_the_sysctl_brand_string(
        self, macos, monkeypatch):
        """macOS has no /proc at all: reading it there raises, is swallowed,
        and the dashboard shows platform.processor() — `arm` — as the chip."""
        issued = []

        def check_output(command, **kwargs):
            issued.append(list(command))
            return 'Apple M2\n'

        monkeypatch.setattr(shared_utils.subprocess, 'check_output', check_output)

        assert shared_utils.get_cpu_name() == 'Apple M2'
        assert issued == [['sysctl', '-n', 'machdep.cpu.brand_string']]

    def test_the_default_gateway_is_the_route_macos_would_take(
        self, macos, uncached_gateway, monkeypatch
    ):
        """`ip` is not a command macOS ships, so without this arm the gateway
        never resolves and latency_ms / packet_loss_pct stay unmeasured for the
        life of the machine."""
        route = (
            '   route to: default\n'
            'destination: default\n'
            '       mask: default\n'
            '    gateway: 192.168.1.1\n'
            '  interface: en0\n'
        )
        issued = []

        def check_output(command, **kwargs):
            issued.append(list(command))
            return route

        monkeypatch.setattr(shared_utils.subprocess, 'check_output', check_output)

        assert shared_utils._detect_default_gateway() == '192.168.1.1'
        assert issued == [['route', '-n', 'get', 'default']]

    def test_the_ping_wait_is_the_unit_this_ping_counts_in(
        self, macos, monkeypatch):
        """BSD ping counts `-W` in milliseconds: `-W 1` waits one millisecond
        for each reply and reports a healthy link as 100% lost."""
        issued = []

        def check_output(command, **kwargs):
            issued.append(list(command))
            return '4 packets transmitted, 4 received, 0% packet loss\n'

        monkeypatch.setattr(shared_utils.subprocess, 'check_output', check_output)

        shared_utils._run_ping('192.168.1.1')

        assert issued == [['ping', '-c', '4', '-W', '1000', '192.168.1.1']]

    def test_a_ping_that_never_answers_is_unmeasured(self, linux, monkeypatch):
        """ping exits non-zero when every packet is lost, and that has always
        come back unmeasured rather than as a reading of 100% loss."""
        def refuse(*args, **kwargs):
            raise shared_utils.subprocess.CalledProcessError(1, 'ping')

        monkeypatch.setattr(shared_utils.subprocess, 'check_output', refuse)

        assert shared_utils._run_ping('10.0.0.1') == {
            'latency_ms': None, 'packet_loss_pct': None,
        }


class TestWmiProbesOffWindows:
    """The WMI probe on the same metrics tick as the three above. Its
    `import wmi` can only fail off Windows, and the failure is a WARNING on
    every tick — the symptom the display probes were guarded against."""

    def test_the_disk_io_probe_is_skipped_off_windows(self, monkeypatch, caplog):
        monkeypatch.setattr(shared_utils, '_IS_WINDOWS', False)
        pools = []

        def record_pool(*args, **kwargs):
            pools.append(args)

        monkeypatch.setattr(shared_utils, 'ThreadPoolExecutor', record_pool)

        with caplog.at_level(logging.DEBUG):
            assert shared_utils.get_disk_io_metrics() == {}

        # Negative control: without the guard the probe builds its worker pool
        # per tick and the ModuleNotFoundError lands on logging.warning.
        assert pools == []
        assert [r for r in caplog.records if r.levelno >= logging.WARNING] == []


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


class TestIdentityPathNormalisation:
    """The spelling an identity record stores, and what a match compares.

    One normaliser, and it is platform-aware: the Windows fold is the whole of
    what it was, and on POSIX the path is the one the kernel reports.
    """

    @pytest.mark.windows(reason='the fold is the Windows comparison')
    def test_windows_folds_separators_and_case(self):
        assert shared_utils.normalize_exe_path(
            'C:/Program Files/Owlette/Show.EXE'
        ) == 'c:\\program files\\owlette\\show.exe'

    @pytest.mark.skipif(
        sys.platform == 'win32', reason='POSIX paths are what is stored here')
    def test_a_posix_record_stores_the_path_the_kernel_reports(self):
        """Every Linux row stored the path backslash-separated and folded —
        harmless to the matcher, which mangled both sides equally, and wrong
        for everything else that reads the record."""
        child = _sleeping_child()
        try:
            record = shared_utils.read_process_identity(child.pid)
            live_exe = psutil.Process(child.pid).exe()
        finally:
            _stop(child)

        assert record['exe'] == live_exe
        assert '\\' not in record['exe']

    @pytest.mark.skipif(
        sys.platform == 'win32', reason='POSIX paths are what is stored here')
    def test_a_recorded_row_still_matches_after_a_restart(self, tmp_path, monkeypatch):
        """What recovery has once `last_started` is empty: the row one run
        wrote, read back by the next and held to the live process."""
        monkeypatch.setattr(
            shared_utils, 'RESULT_FILE_PATH', str(tmp_path / 'app_states.json'))
        child = _sleeping_child()
        try:
            identity = shared_utils.read_process_identity(child.pid)
            shared_utils.update_process_status_in_json(
                child.pid, 'LAUNCHING', process_id='kiosk',
                extra={'create_time': identity['create_time'],
                       'exe': identity['exe']})

            row = shared_utils.read_json_from_file(
                shared_utils.RESULT_FILE_PATH)[str(child.pid)]

            assert shared_utils.identity_matches(
                {'pid': child.pid, 'create_time': row['create_time'],
                 'exe': row['exe']},
                child.pid) is True
        finally:
            _stop(child)

    @pytest.mark.skipif(
        sys.platform == 'win32',
        reason='the Windows ladder is pinned by test_process_lookup')
    def test_the_lookup_compares_the_path_the_kernel_reports(
            self, private_executable):
        """The third comparison of a configured path against a live image, and
        the one that folded on every platform: `/usr/bin/app` became
        `\\usr\\bin\\app`, whose basename is the whole string, so neither the
        full match nor the basename match could ever be true and every tier
        below it — adoption, kill, restart — was unreachable on Linux.
        """
        exe = private_executable('kiosk-app')
        child = subprocess.Popen([str(exe), '30'])
        try:
            found = shared_utils.find_running_process_by_exe(str(exe))
            strict = shared_utils.find_running_process_by_exe(
                str(exe), strict=True)
        finally:
            _stop(child)

        assert found == child.pid
        assert strict == child.pid

    @pytest.mark.skipif(
        sys.platform == 'win32', reason='Windows paths are case-insensitive')
    def test_two_paths_that_differ_only_in_case_are_two_files(self):
        """/usr/bin/Foo and /usr/bin/foo are different executables off Windows,
        so folding the case let a record describing one match the other."""
        child = _sleeping_child()
        try:
            record = shared_utils.read_process_identity(child.pid)
            shouted = record['exe'].upper()
            assert shouted != record['exe']

            assert shared_utils.identity_matches(
                {**record, 'exe': shouted}, child.pid) is False
        finally:
            _stop(child)


@pytest.mark.skipif(
    sys.platform == 'win32', reason='an application bundle is a macOS layout')
class TestApplicationBundles:
    """A configured macOS application bundle is the binary inside it.

    The kernel runs `Contents/MacOS/<CFBundleExecutable>` and psutil reports
    that path, so a bundle path compared as given matched no live process:
    adoption launched a duplicate, a kill found nothing, and a launch refused
    the directory as an executable that does not exist.
    """

    @pytest.fixture(autouse=True)
    def _on_macos(self, monkeypatch):
        # Resolution is plain file reading, so every POSIX leg holds it to the
        # same rules rather than the Mac alone.
        monkeypatch.setattr(shared_utils, '_IS_MACOS', True)

    @staticmethod
    def _bundle(root, info, executable='Kiosk', fmt=plistlib.FMT_XML):
        bundle = root / 'Kiosk.app'
        macos = bundle / 'Contents' / 'MacOS'
        macos.mkdir(parents=True)
        (macos / executable).write_bytes(b'')
        (bundle / 'Contents' / 'Info.plist').write_bytes(plistlib.dumps(info, fmt=fmt))
        return bundle

    @pytest.mark.parametrize('fmt', [plistlib.FMT_XML, plistlib.FMT_BINARY])
    def test_a_bundle_is_the_binary_its_info_plist_names(self, tmp_path, fmt):
        bundle = self._bundle(
            tmp_path, {'CFBundleExecutable': 'KioskBinary'}, 'KioskBinary', fmt)
        inner = str(bundle / 'Contents' / 'MacOS' / 'KioskBinary')

        assert shared_utils.resolve_exec_target(str(bundle)) == inner
        assert shared_utils.resolve_exec_target(f'{bundle}/') == inner

    def test_anything_that_is_not_a_bundle_is_returned_as_given(
            self, tmp_path, monkeypatch):
        bundle = self._bundle(tmp_path, {'CFBundleExecutable': 'Kiosk'})

        assert shared_utils.resolve_exec_target('/usr/bin/true') == '/usr/bin/true'
        assert shared_utils.resolve_exec_target(None) == ''

        # The negative control: off macOS a directory named .app is a directory.
        monkeypatch.setattr(shared_utils, '_IS_MACOS', False)
        assert shared_utils.resolve_exec_target(str(bundle)) == str(bundle)

    @pytest.mark.parametrize('executable', ['../../../bin/sh', '..', '', 'MacOS/Kiosk', 7])
    def test_a_name_that_is_not_a_file_of_the_bundle_does_not_resolve(
            self, tmp_path, executable):
        """Info.plist is the bundle writer's to fill in, and a name that
        climbs out of Contents/MacOS would launch whatever it reaches."""
        bundle = self._bundle(tmp_path, {'CFBundleExecutable': executable})

        assert shared_utils.resolve_exec_target(str(bundle)) == str(bundle)

    def test_a_bundle_whose_info_plist_is_missing_or_broken_does_not_resolve(
            self, tmp_path):
        bundle = self._bundle(tmp_path, {'CFBundleName': 'Kiosk'})
        assert shared_utils.resolve_exec_target(str(bundle)) == str(bundle)

        (bundle / 'Contents' / 'Info.plist').write_bytes(b'<plist><dict><key>')
        assert shared_utils.resolve_exec_target(str(bundle)) == str(bundle)

        (bundle / 'Contents' / 'Info.plist').unlink()
        assert shared_utils.resolve_exec_target(str(bundle)) == str(bundle)

    def test_nothing_below_the_bundle_is_followed_through_a_link(self, tmp_path):
        outside = tmp_path / 'outside'
        outside.mkdir()
        (outside / 'Kiosk').write_bytes(b'')
        (outside / 'Info.plist').write_bytes(
            plistlib.dumps({'CFBundleExecutable': 'Kiosk'}))

        linked_macos = tmp_path / 'one' / 'Kiosk.app' / 'Contents'
        linked_macos.mkdir(parents=True)
        (linked_macos / 'Info.plist').write_bytes(
            plistlib.dumps({'CFBundleExecutable': 'Kiosk'}))
        (linked_macos / 'MacOS').symlink_to(outside)

        linked_binary = self._bundle(tmp_path, {'CFBundleExecutable': 'Kiosk'})
        (linked_binary / 'Contents' / 'MacOS' / 'Kiosk').unlink()
        (linked_binary / 'Contents' / 'MacOS' / 'Kiosk').symlink_to(outside / 'Kiosk')

        linked_plist = tmp_path / 'two' / 'Kiosk.app'
        (linked_plist / 'Contents' / 'MacOS').mkdir(parents=True)
        (linked_plist / 'Contents' / 'MacOS' / 'Kiosk').write_bytes(b'')
        (linked_plist / 'Contents' / 'Info.plist').symlink_to(outside / 'Info.plist')

        for bundle in (linked_macos.parent, linked_binary, linked_plist):
            assert shared_utils.resolve_exec_target(str(bundle)) == str(bundle)

    def test_a_managed_bundle_launches_as_the_binary_inside_it(self, tmp_path):
        """A launch of the bundle directory was refused as an executable that
        does not exist. The binary is what is spawned, since it is what
        supervision later finds by path; `open -a` would hand the launch to
        LaunchServices and leave no pid of ours at all."""
        from osadapter import posix

        bundle = self._bundle(tmp_path, {'CFBundleExecutable': 'Kiosk'})

        assert posix._managed_argv(
            {'exe_path': str(bundle), 'file_path': '--fullscreen'}
        ) == [str(bundle / 'Contents' / 'MacOS' / 'Kiosk'), '--fullscreen']

        # The negative control: a bundle naming no binary of its own is still
        # refused, and never launched as the directory.
        (bundle / 'Contents' / 'MacOS' / 'Kiosk').unlink()
        with pytest.raises(FileNotFoundError):
            posix._managed_argv({'exe_path': str(bundle)})

    def test_a_running_bundle_is_found_by_the_path_the_operator_configured(
            self, tmp_path, monkeypatch, private_executable):
        bundle = tmp_path / 'Kiosk.app'
        (bundle / 'Contents' / 'MacOS').mkdir(parents=True)
        (bundle / 'Contents' / 'Info.plist').write_bytes(
            plistlib.dumps({'CFBundleExecutable': 'Kiosk'}))
        inner = private_executable('Kiosk').rename(
            bundle / 'Contents' / 'MacOS' / 'Kiosk')
        child = subprocess.Popen([str(inner), '30'])
        try:
            found = shared_utils.find_running_process_by_exe(str(bundle), strict=True)
            monkeypatch.setattr(shared_utils, '_IS_MACOS', False)
            unresolved = shared_utils.find_running_process_by_exe(
                str(bundle), strict=True)
        finally:
            _stop(child)

        assert found == child.pid
        # The negative control: the bundle path as given names no live image.
        assert unresolved is None


class TestAppStateWrites:
    """What reaches tmp/app_states.json, and what no longer does.

    The five-second loop stamps RUNNING on every running managed process on
    every tick, so a machine whose processes are all up rewrote the same
    bytes ~17,000 times a day — measured on the Ubuntu kiosk, mtime advancing
    every five seconds against an md5-identical file. Nothing reads this
    file's mtime: the desktop app watches the directory for the atomic
    replace and re-reads the content, and the agent's own readers read the
    content too.
    """

    def test_an_unchanged_row_is_not_written_again(self, tmp_path, monkeypatch):
        states = tmp_path / 'app_states.json'
        monkeypatch.setattr(shared_utils, 'RESULT_FILE_PATH', str(states))
        shared_utils.update_process_status_in_json(
            4242, 'RUNNING', process_id='kiosk')

        written = []
        real_write = shared_utils.write_json_to_file

        def _write(data, file_path, **kwargs):
            written.append(file_path)
            return real_write(data, file_path, **kwargs)

        monkeypatch.setattr(shared_utils, 'write_json_to_file', _write)
        for _ in range(3):
            shared_utils.update_process_status_in_json(
                4242, 'RUNNING', process_id='kiosk')

        # The negative control: every one of those three rewrote the file.
        assert written == []
        assert json.loads(states.read_text(encoding='utf-8')) == {
            '4242': {'status': 'RUNNING', 'id': 'kiosk'}}

    def test_a_row_that_changes_is_written(self, tmp_path, monkeypatch):
        """The half that must not be skipped: a status, an id or a row extra
        the file does not already carry is the whole point of the write."""
        states = tmp_path / 'app_states.json'
        monkeypatch.setattr(shared_utils, 'RESULT_FILE_PATH', str(states))

        shared_utils.update_process_status_in_json(
            4242, 'LAUNCHING', process_id='kiosk')
        shared_utils.update_process_status_in_json(4242, 'RUNNING')
        shared_utils.update_process_status_in_json(
            4242, 'RUNNING', extra={'exe': '/usr/bin/kiosk'})
        shared_utils.update_process_status_in_json(4343, 'LAUNCHING')

        assert json.loads(states.read_text(encoding='utf-8')) == {
            '4242': {'status': 'RUNNING', 'id': 'kiosk', 'exe': '/usr/bin/kiosk'},
            '4343': {'status': 'LAUNCHING'},
        }


def _sleeping_child():
    return subprocess.Popen([sys.executable, '-c', 'import time; time.sleep(30)'])


def _stop(child):
    child.terminate()
    child.wait(10)
