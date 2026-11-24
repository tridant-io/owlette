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


# the links TEC-MBA reported on 2026-11-23: wi-fi en0 carries the traffic and
# has no speed in psutil; only the idle anpi0 and en3 have one
_MAC_FLAGS = 'up,broadcast,notrailers,running,multicast,simplex'
MAC_LINKS = {
    'lo0': SimpleNamespace(isup=True, speed=0, flags='up,loopback,running,multicast'),
    'en0': SimpleNamespace(isup=True, speed=0, flags=_MAC_FLAGS),
    'anpi0': SimpleNamespace(isup=True, speed=100, flags=_MAC_FLAGS),
    'en3': SimpleNamespace(isup=True, speed=100, flags=_MAC_FLAGS),
}


def _io(sent, recv):
    return SimpleNamespace(bytes_sent=sent, bytes_recv=recv)


EN0_PROFILE = {'cpus': [], 'disks': [], 'gpus': [], 'nics': [{'id': 'en0'}]}


@pytest.fixture
def mac_net(monkeypatch):
    """TEC-MBA's links behind psutil, with byte counters and a clock the test
    moves by hand."""
    net = SimpleNamespace(now=100.0, counters={
        'lo0': _io(0, 0), 'en0': _io(1_000, 2_000), 'anpi0': _io(0, 0), 'en3': _io(0, 0)})
    monkeypatch.setattr(shared_utils, '_net_baseline', (0.0, {}))
    monkeypatch.setattr(shared_utils, '_net_last', {'interfaces': {}})
    monkeypatch.setattr(shared_utils.psutil, 'net_if_stats', lambda: MAC_LINKS)
    monkeypatch.setattr(shared_utils.psutil, 'net_io_counters', lambda pernic=False: net.counters)
    monkeypatch.setattr(shared_utils.time, 'time', lambda: net.now)
    return net


def _heartbeat_nics():
    with (
        patch.object(shared_utils, 'get_gpus', return_value=[]),
        patch.object(hardware_profile, '_gpu_temps_cached', return_value=[]),
        patch.object(shared_utils, 'get_network_quality', return_value={}),
        patch.object(shared_utils, 'get_disk_io_metrics', return_value={}),
    ):
        return hardware_profile.collect_dynamic_metrics(EN0_PROFILE)['nics']


@pytest.mark.unit
class TestMacNicThroughput:
    """psutil has no link speed for a Mac's wi-fi, and get_network_metrics
    skipped every link without one, so the nic carrying the traffic read
    0 B/s on every heartbeat while idle links were measured instead."""

    @staticmethod
    def _two_seconds_of_traffic(net):
        baseline = shared_utils.get_network_metrics(advance=True)['interfaces']
        net.now = 102.0
        net.counters = {'lo0': _io(50_000, 50_000), 'en0': _io(201_000, 32_002_000),
                        'anpi0': _io(0, 0), 'en3': _io(0, 0)}
        return baseline

    def test_the_wifi_link_is_measured_without_a_link_speed(self, mac_net):
        baseline = self._two_seconds_of_traffic(mac_net)
        out = shared_utils.get_network_metrics(advance=True)['interfaces']

        assert 'en0' in baseline
        assert out['en0']['rx_bps'] == 16_000_000
        assert out['en0']['tx_bps'] == 100_000
        # utilisation needs a link speed; an unknown one reads 0, not a guess
        assert out['en0']['tx_util'] == 0.0 and out['en0']['rx_util'] == 0.0
        assert 'lo0' not in baseline and 'lo0' not in out

    def test_the_heartbeat_carries_the_wifi_traffic(self, mac_net):
        self._two_seconds_of_traffic(mac_net)

        assert _heartbeat_nics()['en0']['rxBps'] == 16_000_000


@pytest.mark.unit
class TestHeartbeatNetworkWindow:
    """Every upload read the legacy metrics (get_system_metrics) just before
    the heartbeat's own sample, and hoot's system info read them at any time.
    Each read moved the shared baseline, so the heartbeat's rate covered the
    fraction of a second since then instead of the time since the last one."""

    @staticmethod
    def _legacy_read():
        with patch.object(shared_utils, 'get_network_quality', return_value={}):
            return shared_utils.get_system_metrics_with_config({}, skip_gpu=True)['network']['interfaces']

    def test_a_heartbeat_rate_is_its_bytes_over_the_time_since_the_last_one(self, mac_net):
        # each upload reads the legacy metrics first, as firebase_client does;
        # before the first heartbeat that read sets no baseline
        mac_net.now = 100.0
        self._legacy_read()
        mac_net.now = 100.5
        mac_net.counters = {**mac_net.counters, 'en0': _io(1_000, 502_000)}
        assert _heartbeat_nics()['en0']['rxBps'] == 0

        # hoot asks for system info mid-interval
        mac_net.now = 115.0
        mac_net.counters = {**mac_net.counters, 'en0': _io(1_000, 2_002_000)}
        self._legacy_read()

        mac_net.now = 130.0
        mac_net.counters = {**mac_net.counters, 'en0': _io(1_000, 3_502_000)}
        self._legacy_read()
        mac_net.now = 130.5

        # 3 MB in the 30 s since the last heartbeat
        assert _heartbeat_nics()['en0']['rxBps'] == 100_000

        # the next upload's legacy read, and hoot, reuse that sample
        mac_net.now = 131.0
        assert self._legacy_read()['en0']['rx_bps'] == 100_000

    def test_a_read_with_no_heartbeat_lists_the_links_and_leaves_the_counters(self, mac_net, monkeypatch):
        """A filed issue and local hoot run in processes that send no
        heartbeat; their report still names each link and its speed."""
        reads = []
        monkeypatch.setattr(shared_utils.psutil, 'net_io_counters',
                            lambda pernic=False: reads.append(pernic) or mac_net.counters)

        zero = {'tx_bps': 0, 'rx_bps': 0, 'tx_util': 0.0, 'rx_util': 0.0}
        assert self._legacy_read() == {
            'en0': {**zero, 'link_speed': 0},
            'anpi0': {**zero, 'link_speed': 100},
            'en3': {**zero, 'link_speed': 100},
        }
        assert reads == []
        assert shared_utils._net_baseline == (0.0, {})
