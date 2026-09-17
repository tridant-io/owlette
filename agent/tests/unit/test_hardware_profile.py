"""
Tests for hardware_profile's dynamic-metrics collection.

Covers the join between the stored profile's GPU entries and the live NVML
readings, which is keyed on the GPU id rather than list position.
"""

from types import SimpleNamespace

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

# _collect_disks stores a mount point with its separator stripped, which leaves
# a POSIX volume as the path itself and a windows drive as a bare letter.
DISK_PROFILE = {
    'gpus': [],
    'disks': [
        {'id': '/', 'label': '/dev/sda2', 'fs': 'ext4', 'totalGb': 100.0},
        {'id': '/home', 'label': '/dev/sda3', 'fs': 'ext4', 'totalGb': 900.0},
        {'id': 'C:', 'label': 'C:', 'fs': 'NTFS', 'totalGb': 500.0},
    ],
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


@pytest.mark.unit
class TestCollectDynamicMetricsDisks:
    """Every id in profile.disks has to come back with a reading"""

    def test_a_posix_mount_point_is_asked_for_as_it_stands(self):
        """'/home\\' is not a mount point and psutil answers nothing for it,
        which dropped every volume on a POSIX machine but the root."""
        asked = []

        def usage(mount):
            asked.append(mount)
            return SimpleNamespace(percent=42.0, used=10 * 1024 ** 3)

        with (
            patch.object(hardware_profile, '_disk_usage_with_timeout', side_effect=usage),
            patch.object(shared_utils, 'get_gpus', return_value=[]),
            patch.object(hardware_profile, '_gpu_temps_cached', return_value=[]),
            patch.object(shared_utils, 'get_network_metrics', return_value={}),
        ):
            disks = hardware_profile.collect_dynamic_metrics(DISK_PROFILE)['disks']

        assert asked == ['/', '/home', 'C:\\']
        assert set(disks) == {'/', '/home', 'C:'}
        assert disks['/home']['percent'] == 42.0
        assert disks['/home']['usedGb'] == 10.0
