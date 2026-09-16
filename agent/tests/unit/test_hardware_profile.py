"""
Tests for hardware_profile's dynamic-metrics collection.

Covers the join between the stored profile's GPU entries and the live NVML
readings, which is keyed on the GPU id rather than list position.
"""

import pytest
from unittest.mock import patch

import hardware_profile
import shared_utils


def _reading(index, uuid, load, vram_used_mb):
    return shared_utils.GpuReading(
        id=index,
        uuid=uuid,
        name='NVIDIA Test {0}'.format(index),
        load=load,
        memoryTotal=8192.0,
        memoryUsed=vram_used_mb,
        memoryFree=8192.0 - vram_used_mb,
    )


PROFILE = {
    'gpus': [
        {'id': 'GPU-aaa', 'name': 'NVIDIA Test 0', 'vramTotalGb': 8.0, 'pciBus': None},
        {'id': 'GPU-bbb', 'name': 'NVIDIA Test 1', 'vramTotalGb': 8.0, 'pciBus': None},
    ],
    'disks': [],
    'nics': [],
}


def _collect(live):
    with (
        patch.object(shared_utils, 'get_gpus', return_value=live),
        patch.object(hardware_profile, '_gpu_temps_cached', return_value=[]),
        patch.object(shared_utils, 'get_network_metrics', return_value={}),
    ):
        return hardware_profile.collect_dynamic_metrics(PROFILE)['gpus']


@pytest.mark.unit
class TestCollectDynamicMetricsGpus:
    """GPU readings must land on the profile entry they came from"""

    def test_each_gpu_gets_its_own_reading(self):
        out = _collect([
            _reading(0, 'GPU-aaa', 0.10, 1024.0),
            _reading(1, 'GPU-bbb', 0.90, 4096.0),
        ])

        assert out['GPU-aaa']['usagePercent'] == 10.0
        assert out['GPU-aaa']['vramUsedGb'] == 1.0
        assert out['GPU-bbb']['usagePercent'] == 90.0
        assert out['GPU-bbb']['vramUsedGb'] == 4.0

    def test_unreadable_device_does_not_shift_the_survivor(self):
        # GPU 0 failed its NVML read, so only GPU 1 comes back. A positional
        # join would report GPU 1's load against GPU 0.
        out = _collect([_reading(1, 'GPU-bbb', 0.90, 4096.0)])

        assert out['GPU-aaa']['usagePercent'] == 0.0
        assert out['GPU-aaa']['vramUsedGb'] == 0.0
        assert out['GPU-bbb']['usagePercent'] == 90.0
        assert out['GPU-bbb']['vramUsedGb'] == 4.0
