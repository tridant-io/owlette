"""
Tests for hardware_profile's dynamic-metrics collection.

Covers the join between the stored profile's GPU entries and the live NVML
readings, which is keyed on the GPU id rather than list position.
"""

import logging
import sys
from types import ModuleType, SimpleNamespace

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


@pytest.mark.unit
class TestCollectCpusOffWindows:
    """The 300 s profile rebuild runs on the metrics thread, and off
    Windows its socket-topology query can only fail — into a WARNING,
    every rebuild."""

    def test_the_wmi_socket_query_is_skipped_off_windows(self, monkeypatch, caplog):
        monkeypatch.setattr(hardware_profile, '_IS_WINDOWS', False)
        probe = ModuleType('wmi')

        def reached():
            raise AssertionError('wmi.WMI() was called off Windows')

        probe.WMI = reached
        monkeypatch.setitem(sys.modules, 'wmi', probe)

        with caplog.at_level(logging.DEBUG):
            cpus = hardware_profile._collect_cpus()

        assert [cpu['id'] for cpu in cpus] == ['CPU0']
        # Negative control: without the guard the stub is imported, WMI()
        # raises and the fallback logs it at WARNING on every rebuild.
        assert [r for r in caplog.records if r.levelno >= logging.WARNING] == []


# the mounts and interfaces Bryant Place's M5 Max reported on 2026-10-12
MAC_MOUNTS = [
    '/', '/System/Volumes/VM', '/System/Volumes/Preboot', '/System/Volumes/Update',
    '/System/Volumes/xarts', '/System/Volumes/iSCPreboot', '/System/Volumes/Hardware',
    '/System/Volumes/Data', '/Library/Developer/CoreSimulator/Volumes/iOS_23F77',
    '/Library/Developer/CoreSimulator/Volumes/xrOS_23O470', '/Volumes/Backup',
]
MAC_NICS = ['en0', 'utun0', 'utun1', 'utun12', 'awdl0', 'llw0']


def _partitions(mounts):
    return [SimpleNamespace(device='/dev/disk3s1', mountpoint=m, fstype='apfs', opts='rw') for m in mounts]


def _interfaces(monkeypatch, names):
    import socket
    monkeypatch.setattr(hardware_profile.psutil, 'net_if_stats', lambda: {
        n: SimpleNamespace(isup=True, speed=0) for n in names})
    monkeypatch.setattr(hardware_profile.psutil, 'net_if_addrs', lambda: {
        n: [SimpleNamespace(family=socket.AF_INET6, address='fe80::1')] for n in names})


@pytest.mark.unit
class TestMacProfileNoise:
    """A Mac mounts simulator runtimes and system helper volumes, and adds and
    drops tunnels at will. In the profile they changed its signature seven times
    a day and became the "primary" disk (a simulator volume, 97% full) and nic
    (`utun0`)."""

    @pytest.fixture(autouse=True)
    def _disk_usage(self, monkeypatch):
        monkeypatch.setattr(hardware_profile, '_disk_usage_with_timeout',
                            lambda mount: SimpleNamespace(total=500 * 1024 ** 3))

    def test_a_mac_profiles_only_its_own_volumes(self, monkeypatch):
        monkeypatch.setattr(hardware_profile, '_IS_MACOS', True)
        monkeypatch.setattr(hardware_profile.psutil, 'disk_partitions', lambda all=False: _partitions(MAC_MOUNTS))

        assert [d['id'] for d in hardware_profile._collect_disks()] == [
            '/', '/System/Volumes/Data', '/Volumes/Backup']

    def test_a_mac_profiles_no_tunnels_or_wireless_side_channels(self, monkeypatch):
        monkeypatch.setattr(hardware_profile, '_IS_MACOS', True)
        _interfaces(monkeypatch, MAC_NICS)

        assert [n['id'] for n in hardware_profile._collect_nics()] == ['en0']

    def test_off_macos_nothing_is_filtered(self, monkeypatch):
        monkeypatch.setattr(hardware_profile, '_IS_MACOS', False)
        monkeypatch.setattr(hardware_profile.psutil, 'disk_partitions', lambda all=False: _partitions(MAC_MOUNTS))
        _interfaces(monkeypatch, MAC_NICS)

        assert len(hardware_profile._collect_disks()) == len(MAC_MOUNTS)
        assert [n['id'] for n in hardware_profile._collect_nics()] == MAC_NICS
