"""
Unit tests for the temperature path: the temperature.enabled config gate, the
sensor contracts, the read watchdog, and the pynvml fallback ordering.

temp_sensors itself is mocked throughout — these tests must run on machines
with no PawnIO driver, no admin rights, and no .NET CLR.
"""

import sys
import time
import types
from unittest.mock import patch

import pytest

import shared_utils


def _mock_temp_sensors(cpu=None, gpus=None, cpu_raises=None):
    """A stand-in temp_sensors module installed via sys.modules."""
    mod = types.ModuleType('temp_sensors')

    def read_cpu_temperature():
        if cpu_raises is not None:
            raise cpu_raises
        return cpu

    mod.read_cpu_temperature = read_cpu_temperature
    mod.read_gpu_temperatures = lambda: [] if gpus is None else gpus
    return mod


@pytest.fixture(autouse=True)
def _reset_watchdog_latch():
    """Each test starts with the shared suppression latch clear."""
    shared_utils._temp_suppressed_until = 0.0
    yield
    shared_utils._temp_suppressed_until = 0.0


@pytest.fixture
def _no_pynvml():
    """Make the pynvml fallback unavailable so tests isolate the LHM branch."""
    with patch.dict(sys.modules, {'pynvml': None}):
        yield


class TestTemperatureToggle:
    """temperature.enabled gates every sensor read; missing key means enabled."""

    def test_cpu_disabled_skips_sensor_entirely(self):
        # sys.modules poisoned: any import of temp_sensors would raise. The
        # gate must return before the import is ever attempted.
        with patch.object(shared_utils, 'read_config', return_value=False) as rc:
            with patch.dict(sys.modules, {'temp_sensors': None}):
                assert shared_utils.get_cpu_temperature() is None
            rc.assert_called_once_with(['temperature', 'enabled'])

    def test_gpu_disabled_skips_sensor_entirely(self, _no_pynvml):
        with patch.object(shared_utils, 'read_config', return_value=False):
            with patch.dict(sys.modules, {'temp_sensors': None}):
                assert shared_utils.get_gpu_temperatures() == []

    def test_missing_key_means_enabled(self, _no_pynvml):
        # read_config returns None for a missing path — only literal False
        # disables (the displays.enabled sentinel idiom).
        with patch.object(shared_utils, 'read_config', return_value=None):
            with patch.dict(sys.modules, {'temp_sensors': _mock_temp_sensors(cpu=55.0, gpus=[61.0])}):
                assert shared_utils.get_cpu_temperature() == 55.0
                assert shared_utils.get_gpu_temperatures() == [
                    {'index': 0, 'temperature': 61.0}
                ]


class TestSensorContracts:
    """Return shapes and the 0 < t < 150 sanity filter."""

    def test_cpu_out_of_range_becomes_none(self):
        with patch.object(shared_utils, 'read_config', return_value=None):
            for bogus in (0, -12.0, 150, 512.0):
                with patch.dict(sys.modules, {'temp_sensors': _mock_temp_sensors(cpu=bogus)}):
                    assert shared_utils.get_cpu_temperature() is None

    def test_cpu_sensor_exception_degrades_to_none(self):
        with patch.object(shared_utils, 'read_config', return_value=None):
            mod = _mock_temp_sensors(cpu_raises=RuntimeError('driver gone'))
            with patch.dict(sys.modules, {'temp_sensors': mod}):
                assert shared_utils.get_cpu_temperature() is None

    def test_gpu_positional_index_survives_none_gaps(self, _no_pynvml):
        # A GPU with no readable temp yields None in temp_sensors' list; its
        # slot must be filtered out while later GPUs keep their real index.
        with patch.object(shared_utils, 'read_config', return_value=None):
            with patch.dict(sys.modules, {'temp_sensors': _mock_temp_sensors(gpus=[None, 72.0])}):
                assert shared_utils.get_gpu_temperatures() == [
                    {'index': 1, 'temperature': 72.0}
                ]


class TestWatchdog:
    """_temp_read_with_timeout bounds hung reads and latches a cooldown."""

    def test_timeout_returns_none_and_latches(self):
        def hang():
            time.sleep(5)

        assert shared_utils._temp_read_with_timeout('t', hang, timeout=0.1) is None
        assert shared_utils._temp_suppressed_until > time.monotonic()
        # Latched: an instant read is refused without invoking fn.
        calls = []
        assert shared_utils._temp_read_with_timeout('t', lambda: calls.append(1)) is None
        assert calls == []

    def test_fast_read_passes_through(self):
        assert shared_utils._temp_read_with_timeout('t', lambda: 42.0) == 42.0

    def test_exception_does_not_latch(self):
        def boom():
            raise OSError('device error')

        assert shared_utils._temp_read_with_timeout('t', boom) is None
        assert shared_utils._temp_suppressed_until == 0.0


class TestPynvmlFallback:
    """pynvml runs only when the LHM path yields nothing."""

    def _fake_pynvml(self, temps, shutdown_calls):
        mod = types.ModuleType('pynvml')
        mod.NVML_TEMPERATURE_GPU = 0
        # the two error classes the read imports beside the calls
        mod.NVMLError_LibraryNotFound = type('NVMLError_LibraryNotFound', (Exception,), {})
        mod.NVMLError_DriverNotLoaded = type('NVMLError_DriverNotLoaded', (Exception,), {})
        mod.nvmlInit = lambda: None
        mod.nvmlDeviceGetCount = lambda: len(temps)
        mod.nvmlDeviceGetHandleByIndex = lambda i: i
        mod.nvmlDeviceGetTemperature = lambda handle, kind: temps[handle]
        mod.nvmlShutdown = lambda: shutdown_calls.append(1)
        return mod

    def test_lhm_success_short_circuits_pynvml(self):
        shutdown_calls = []
        fake = self._fake_pynvml([99.0], shutdown_calls)
        with patch.object(shared_utils, 'read_config', return_value=None):
            with patch.dict(sys.modules, {
                'temp_sensors': _mock_temp_sensors(gpus=[70.0]),
                'pynvml': fake,
            }):
                assert shared_utils.get_gpu_temperatures() == [
                    {'index': 0, 'temperature': 70.0}
                ]
        assert shutdown_calls == []

    def test_pynvml_fallback_when_lhm_empty(self):
        shutdown_calls = []
        fake = self._fake_pynvml([66.0, 71.0], shutdown_calls)
        with patch.object(shared_utils, 'read_config', return_value=None), \
                patch.object(shared_utils, '_IS_MACOS', False):
            with patch.dict(sys.modules, {
                'temp_sensors': _mock_temp_sensors(gpus=[]),
                'pynvml': fake,
            }):
                assert shared_utils.get_gpu_temperatures() == [
                    {'index': 0, 'temperature': 66.0},
                    {'index': 1, 'temperature': 71.0},
                ]
        # nvmlShutdown ran exactly once (finally-guarded).
        assert shutdown_calls == [1]

    def test_macos_never_tries_nvml(self):
        # no nvidia driver exists for macos, so the read could only fail, and it
        # logged a warning on every metrics pass
        shutdown_calls = []
        fake = self._fake_pynvml([66.0], shutdown_calls)
        with patch.object(shared_utils, 'read_config', return_value=None), \
                patch.object(shared_utils, '_IS_MACOS', True):
            with patch.dict(sys.modules, {
                'temp_sensors': _mock_temp_sensors(gpus=[]),
                'pynvml': fake,
            }):
                assert shared_utils.get_gpu_temperatures() == []
        assert shutdown_calls == []


class TestConfigDefaults:
    """The temperature section ships in generated configs and upgrades."""

    def test_generate_config_file_includes_temperature(self):
        with patch.object(shared_utils, 'read_config', return_value={}):
            config = shared_utils.generate_config_file()
        assert config['temperature'] == {'enabled': True}

    def test_generate_config_file_backfills_existing(self):
        existing = {'version': '1.6.0', 'processes': []}
        with patch.object(shared_utils, 'read_config', return_value={}):
            config = shared_utils.generate_config_file(existing_config=existing)
        assert config['temperature'] == {'enabled': True}

    def test_upgrade_config_backfills_outside_version_gate(self):
        # Regression: a config already stamped with the current CONFIG_VERSION
        # but missing the temperature section (e.g. a remote pull wholesale-
        # replaced config.json) must still receive the backfill — the section
        # write is deliberately not gated on a version bump.
        existing = {'version': shared_utils.CONFIG_VERSION, 'processes': []}
        written = {}
        with patch.object(shared_utils, 'read_json_from_file', return_value=existing):
            with patch.object(
                shared_utils, 'write_json_to_file',
                side_effect=lambda data, path: written.update(data),
            ):
                shared_utils.upgrade_config()
        assert written.get('temperature') == {'enabled': True}
        assert written['version'] == shared_utils.CONFIG_VERSION
