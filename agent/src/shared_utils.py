import os
import json
import functools
import logging
from logging.handlers import RotatingFileHandler
import socket
from packaging import version
import psutil
import platform
import subprocess
import sys
import threading
from concurrent.futures import ThreadPoolExecutor, TimeoutError as FuturesTimeoutError
import winreg
import time
from pathlib import Path

import acl_hardening

# VERSION MANAGEMENT
def get_app_version():
    """Version string from agent/VERSION, or "0.0.0" if it can't be read."""
    try:
        version_file = Path(__file__).parent.parent / 'VERSION'
        if version_file.exists():
            return version_file.read_text().strip()
        else:
            logging.warning("VERSION file not found — using fallback '0.0.0'")
            return '0.0.0'
    except Exception as e:
        logging.warning(f"Failed to read VERSION file: {e} — using fallback '0.0.0'")
        return '0.0.0'

# GLOBAL VARS

APP_VERSION = get_app_version()
CONFIG_VERSION = '1.7.0'  # Added temperature.enabled (PawnIO migration)
SERVICE_NAME = 'OwletteService'


# OS
json_lock = threading.Lock()

# Cross-process mutex for JSON file access (service + desktop app coordination)
_json_file_mutex = None

_JSON_MUTEX_NAME = "Global\\OwletteJsonFileMutex"

# Explicit DACL required. A LocalSystem-created object with a NULL descriptor is
# reachable by SYSTEM/Administrators only, so everyone else got ACCESS_DENIED on
# both CreateMutex and OpenMutex and _CrossProcessLock silently became a no-op
# (measured 2026-08-12). Whoever creates the object sets its DACL for life.
# Authenticated Users get SYNCHRONIZE|MUTEX_MODIFY_STATE and nothing more — no
# WRITE_DAC, so a user process cannot re-permission it.
_JSON_MUTEX_SDDL = "D:(A;;0x1F0001;;;SY)(A;;0x1F0001;;;BA)(A;;0x100001;;;AU)"

# The two rights the descriptor above hands to ordinary users.
_MUTEX_OPEN_ACCESS = 0x00100000 | 0x0001  # SYNCHRONIZE | MUTEX_MODIFY_STATE


def _get_json_file_mutex():
    """Get or create the Windows named mutex for cross-process JSON file locking.

    Created with an explicit descriptor (_JSON_MUTEX_SDDL) so whichever process
    wins the race leaves the object reachable by everyone else. CreateMutex asks
    for MUTEX_ALL_ACCESS, which that descriptor withholds from ordinary users, so
    a non-elevated process falls through to OpenMutex. The desktop host does the
    same (desktop/src-tauri/src/json_io.rs::json_mutex).
    """
    global _json_file_mutex
    if _json_file_mutex is None:
        try:
            import win32event
            import win32security

            attributes = win32security.SECURITY_ATTRIBUTES()
            attributes.SECURITY_DESCRIPTOR = (
                win32security.ConvertStringSecurityDescriptorToSecurityDescriptor(
                    _JSON_MUTEX_SDDL, win32security.SDDL_REVISION_1
                )
            )
            _json_file_mutex = win32event.CreateMutex(attributes, False, _JSON_MUTEX_NAME)
        except Exception as create_error:
            try:
                import win32event
                _json_file_mutex = win32event.OpenMutex(
                    _MUTEX_OPEN_ACCESS, False, _JSON_MUTEX_NAME
                )
            except Exception as open_error:
                # Both refused: proceed unlocked. Writes are atomic (temp file
                # + os.replace), so worst case is a lost update, not a torn file.
                logging.debug(
                    f"Cross-process JSON mutex unavailable "
                    f"(create: {create_error}; open: {open_error}) — proceeding unlocked"
                )
                _json_file_mutex = False  # Fallback: skip cross-process locking
    return _json_file_mutex

class _CrossProcessLock:
    """Context manager for cross-process file locking using a Windows named mutex."""
    def __init__(self, timeout_ms=2000):
        self.timeout_ms = timeout_ms
        self.mutex = _get_json_file_mutex()
        self.acquired = False

    def __enter__(self):
        if self.mutex:
            try:
                import win32event, win32con
                result = win32event.WaitForSingleObject(self.mutex, self.timeout_ms)
                self.acquired = result in (win32event.WAIT_OBJECT_0, win32event.WAIT_ABANDONED)
            except Exception:
                pass
        return self

    def __exit__(self, *args):
        if self.acquired and self.mutex:
            try:
                import win32event
                win32event.ReleaseMutex(self.mutex)
            except Exception:
                pass

def get_hostname():
    return socket.gethostname()

def get_machine_timezone():
    """Machine timezone as the Windows registry name (e.g. "Pacific Standard
    Time"). Diagnostics/back-compat only — the dashboard consumes the IANA form
    from get_machine_timezone_iana().
    """
    try:
        with winreg.OpenKey(winreg.HKEY_LOCAL_MACHINE,
                            r'SYSTEM\CurrentControlSet\Control\TimeZoneInformation') as key:
            return winreg.QueryValueEx(key, 'TimeZoneKeyName')[0]
    except Exception:
        return None


def get_machine_timezone_iana():
    """Machine timezone as an IANA name (e.g. "America/Los_Angeles").

    zoneinfo.ZoneInfo() and Intl.DateTimeFormat({timeZone}) both require IANA
    names; the Windows registry value works with neither. tzlocal maps via the
    CLDR Windows-to-IANA table. None on failure — the dashboard degrades.
    """
    try:
        import tzlocal
        return tzlocal.get_localzone_name()
    except Exception as e:
        logging.debug(f"Could not determine machine IANA timezone: {e}")
        return None

def get_cpu_name():
    """CPU model name (e.g. "Intel(R) Core(TM) i9-9900X CPU @ 3.50GHz"), or
    "Unknown CPU" if every probe fails. Fastest/most reliable source first.
    """
    # 1. Registry — fast, no admin rights
    try:
        key = winreg.OpenKey(winreg.HKEY_LOCAL_MACHINE,
                            r'HARDWARE\DESCRIPTION\System\CentralProcessor\0')
        cpu_name = winreg.QueryValueEx(key, 'ProcessorNameString')[0].strip()
        winreg.CloseKey(key)
        if cpu_name:
            return cpu_name
    except Exception as e:
        logging.debug(f"Registry CPU detection failed: {e}")

    # 2. PowerShell CIM — Windows 11 compatible
    try:
        result = subprocess.run(
            ['powershell', '-NoProfile', '-Command',
             'Get-CimInstance -ClassName Win32_Processor | Select-Object -ExpandProperty Name'],
            capture_output=True,
            text=True,
            timeout=5,
            creationflags=subprocess.CREATE_NO_WINDOW  # No console flash
        )
        if result.returncode == 0 and result.stdout.strip():
            cpu_name = result.stdout.strip()
            if cpu_name:
                return cpu_name
    except Exception as e:
        logging.debug(f"PowerShell CPU detection failed: {e}")

    # 3. platform.processor() — incomplete but always available
    try:
        cpu_name = platform.processor()
        if cpu_name:
            return cpu_name
    except Exception as e:
        logging.debug(f"platform.processor() failed: {e}")

    logging.warning("All CPU detection methods failed")
    return "Unknown CPU"

# Temperature read suppression. A timed-out read (hung driver bind or CLR
# load) leaks its worker thread — the watchdog can't kill it — so a persistent
# hang would leak one per metrics tick. Latch a cooldown after any timeout.
# CPU + GPU share the latch (same LHM Computer); GPU falls through to pynvml
# meanwhile. Monotonic: immune to wall-clock changes.
_TEMP_TIMEOUT_COOLDOWN_S = 600
_temp_suppressed_until = 0.0


def _temp_read_with_timeout(label: str, fn, timeout: float = 3.0):
    """Run a temp_sensors read under a watchdog.

    temp_sensors binds the PawnIO ring-0 driver (via LibreHardwareMonitor) on
    first use. try/except catches a *failed* load but not a *hung* one, and
    these reads sit on service startup (firebase_client.start ->
    get_system_metrics) and the heartbeat thread. Bound it so a hung load
    degrades to None. Mirrors _wmi_logical_disk_with_timeout. A timeout
    latches _TEMP_TIMEOUT_COOLDOWN_S so a persistent hang doesn't spawn a
    leaked worker per call.
    """
    global _temp_suppressed_until
    now = time.monotonic()
    if now < _temp_suppressed_until:
        return None
    pool = ThreadPoolExecutor(max_workers=1)
    try:
        future = pool.submit(fn)
        try:
            return future.result(timeout=timeout)
        except FuturesTimeoutError:
            _temp_suppressed_until = now + _TEMP_TIMEOUT_COOLDOWN_S
            logging.warning(
                f"[TEMP] {label} timed out after {timeout}s — PawnIO driver or CLR "
                f"load may be blocked; suppressing sensor reads for {_TEMP_TIMEOUT_COOLDOWN_S}s"
            )
            return None
        except Exception as e:
            logging.debug(f"[TEMP] {label} error: {e}")
            return None
    finally:
        # wait=False: the default `with`-shutdown(wait=True) would deadlock on
        # the very hang this watchdog exists to survive.
        pool.shutdown(wait=False, cancel_futures=True)


def get_cpu_temperature():
    """CPU temperature in Celsius via LibreHardwareMonitor (PawnIO), or None.

    Needs admin (the service has it); unsupported hardware or an absent PawnIO
    driver yields None. Bounded by _temp_read_with_timeout so a hung driver
    load can't stall startup or the heartbeat. temperature.enabled=false in
    config disables all sensor reads; a missing key means enabled.
    """
    if read_config(['temperature', 'enabled']) is False:
        return None
    try:
        import temp_sensors

        cpu_temp = _temp_read_with_timeout("CPU_Temp", temp_sensors.read_cpu_temperature)

        if cpu_temp is not None and 0 < cpu_temp < 150:
            return float(cpu_temp)
        return None

    except ImportError:
        logging.debug("[TEMP] HardwareMonitor not available")
        return None

    except Exception as e:
        # Broad boundary: callers (hardware_profile.collect_dynamic_metrics)
        # read this unguarded, so every failure must degrade to None.
        logging.debug(f"[TEMP] sensor error: {e}")
        return None

def get_gpu_temperatures():
    """GPU temperatures in Celsius: [{'index': 0, 'temperature': 72.0}], or [].

    LibreHardwareMonitor (NVIDIA/AMD/Intel, needs admin) then pynvml (NVIDIA
    only, works unprivileged). Always Celsius — the storage standard.
    temperature.enabled=false in config disables all sensor reads; a missing
    key means enabled.
    """
    if read_config(['temperature', 'enabled']) is False:
        return []

    # 1. LibreHardwareMonitor via temp_sensors — NVIDIA, AMD, Intel
    try:
        import temp_sensors
        all_temps = _temp_read_with_timeout("GPU_Temps", temp_sensors.read_gpu_temperatures)

        if all_temps:
            temps = []
            for i, temp in enumerate(all_temps):
                if temp is not None and 0 < temp < 150:
                    temps.append({
                        'index': i,
                        'temperature': float(temp)
                    })
            if temps:
                return temps

    except ImportError:
        logging.debug("[TEMP] HardwareMonitor not available")
    except Exception as e:
        logging.debug(f"[TEMP] sensor error: {e}")

    # 2. pynvml — NVIDIA only
    try:
        from pynvml import nvmlInit, nvmlDeviceGetCount, nvmlDeviceGetHandleByIndex, nvmlDeviceGetTemperature, nvmlShutdown, NVML_TEMPERATURE_GPU

        temps = []
        nvmlInit()
        try:
            gpu_count = nvmlDeviceGetCount()

            for i in range(gpu_count):
                try:
                    handle = nvmlDeviceGetHandleByIndex(i)
                    temp = nvmlDeviceGetTemperature(handle, NVML_TEMPERATURE_GPU)

                    if temp is not None and 0 < temp < 150:
                        temps.append({
                            'index': i,
                            'temperature': float(temp)
                        })
                except Exception as e:
                    logging.warning(f"[TEMP] pynvml failed for GPU {i}: {e}")
        finally:
            nvmlShutdown()

        if temps:
            return temps

    except ImportError as e:
        logging.warning(f"[TEMP] pynvml not installed - GPU temperature unavailable: {e}")
    except Exception as e:
        logging.warning(f"[TEMP] pynvml GPU temp failed: {e}")

    return []


# Network monitoring state for delta calculation
_prev_net_counters: dict = {}
_prev_net_time: float = 0.0


def get_network_metrics():
    """Per-NIC throughput, as deltas between consecutive calls. First call
    returns zeros — no baseline yet.

    Returns {'interfaces': {name: {tx_bps, rx_bps (bytes/sec), tx_util, rx_util
    (% of link speed, 0-100), link_speed (Mbps)}}}.
    """
    global _prev_net_counters, _prev_net_time

    result = {'interfaces': {}}
    now = time.time()

    try:
        counters = psutil.net_io_counters(pernic=True)
        nic_stats = psutil.net_if_stats()

        if not _prev_net_counters or _prev_net_time == 0.0:
            # First call — baseline only
            _prev_net_counters = {
                name: {'sent': c.bytes_sent, 'recv': c.bytes_recv}
                for name, c in counters.items()
            }
            _prev_net_time = now
            # Zeros rather than {} so the web never sees an empty result
            for name in counters:
                stats = nic_stats.get(name)
                if stats and stats.isup and stats.speed > 0 and 'loopback' not in name.lower():
                    result['interfaces'][name] = {
                        'tx_bps': 0, 'rx_bps': 0,
                        'tx_util': 0.0, 'rx_util': 0.0,
                        'link_speed': stats.speed,
                    }
            return result

        elapsed = now - _prev_net_time
        if elapsed <= 0:
            return result

        for name, c in counters.items():
            stats = nic_stats.get(name)
            if not stats or not stats.isup:
                continue

            if stats.speed == 0 or 'loopback' in name.lower():
                continue

            prev = _prev_net_counters.get(name)
            if not prev:
                continue

            # Clamp negatives — counter reset
            tx_delta = max(0, c.bytes_sent - prev['sent'])
            rx_delta = max(0, c.bytes_recv - prev['recv'])

            tx_bps = int(tx_delta / elapsed)
            rx_bps = int(rx_delta / elapsed)

            link_speed_mbps = stats.speed  # Mbps
            link_speed_bps = link_speed_mbps * 1_000_000 / 8  # Convert to bytes/sec

            if link_speed_bps > 0:
                tx_util = round(min((tx_bps / link_speed_bps) * 100, 100.0), 1)
                rx_util = round(min((rx_bps / link_speed_bps) * 100, 100.0), 1)
            else:
                tx_util = 0.0
                rx_util = 0.0

            result['interfaces'][name] = {
                'tx_bps': tx_bps,
                'rx_bps': rx_bps,
                'tx_util': tx_util,
                'rx_util': rx_util,
                'link_speed': link_speed_mbps,
            }

        _prev_net_counters = {
            name: {'sent': c.bytes_sent, 'recv': c.bytes_recv}
            for name, c in counters.items()
        }
        _prev_net_time = now

    except Exception as e:
        logging.error(f"Error collecting network metrics: {e}")

    return result


def _wmi_logical_disk_with_timeout(timeout: float = 10.0):
    """Query Win32_PerfFormattedData_PerfDisk_LogicalDisk under a watchdog.

    Per-call worker, not a persistent one: the `wmi` package binds proxies to
    the apartment that created them, so a cached proxy raises RPC_E_WRONG_THREAD
    (0x8001010E) on the second query. ~350ms is fine at the 120s idle cadence.

    Fields are extracted in-worker and returned as plain dicts — reading a COM
    proxy after its apartment is torn down is a dangling pointer, segfault on
    next attribute access.

    10s timeout sized for perflib LogicalDisk stalls when BITS flips state during
    Windows Update / Delivery Optimization: 2s and 5s both timed out ~3-4x/hour,
    spaced ~16 min apart matching SCM event 7040. The metrics loop has its own
    thread, so a 10s call stalls nothing else.
    """
    def _query():
        try:
            import pythoncom
            pythoncom.CoInitialize()
        except Exception:
            pass
        import wmi
        c = wmi.WMI()
        return [
            {
                'Name': str(getattr(row, 'Name', '') or ''),
                'DiskReadBytesPerSec': int(getattr(row, 'DiskReadBytesPerSec', 0) or 0),
                'DiskWriteBytesPerSec': int(getattr(row, 'DiskWriteBytesPerSec', 0) or 0),
                'DiskReadsPerSec': int(getattr(row, 'DiskReadsPerSec', 0) or 0),
                'DiskWritesPerSec': int(getattr(row, 'DiskWritesPerSec', 0) or 0),
                'PercentIdleTime': float(getattr(row, 'PercentIdleTime', 100) or 100),
            }
            for row in c.Win32_PerfFormattedData_PerfDisk_LogicalDisk()
        ]

    # Manual lifecycle (not `with`): shutdown(wait=True) would block on a hung
    # WMI worker and defeat the watchdog. A leaked thread per failed tick is
    # acceptable; stalling the metrics loop is not.
    pool = ThreadPoolExecutor(max_workers=1)
    try:
        future = pool.submit(_query)
        try:
            return future.result(timeout=timeout)
        except FuturesTimeoutError:
            logging.warning('Win32_PerfFormattedData_PerfDisk_LogicalDisk timed out — skipping sample')
            return None
        except Exception as e:
            logging.warning(f'Win32_PerfFormattedData_PerfDisk_LogicalDisk failed: {e}')
            return None
    finally:
        pool.shutdown(wait=False, cancel_futures=True)


# Disk IO max-throughput estimation. `metrics.diskio[*].maxBps` is the
# denominator the web plots read/write against as 0-100% utilization, computed as
# max(hardware_estimate, observed_peak): the hardware estimate comes once from
# MSFT_PhysicalDisk BusType+MediaType; the peak ratchets upward in memory so a
# conservative estimate self-corrects. Cached per drive letter, cleared on
# service restart (warm-up is one WMI tick).
_disk_max_bps_cache: dict = {}        # volume_id -> int (bytes/sec)
_disk_max_bps_hw_resolved: bool = False
_disk_max_bps_lock = threading.Lock()

# Conservative class baselines — tuned so the chart reads ~30-60% under a normal
# heavy workload, not best-case marketing numbers. The ratchet covers faster drives.
_DISK_MAX_BPS_BY_CLASS = {
    ('NVMe',  'SSD'):      3_500 * 1024 * 1024,   # ~3.5 GB/s
    ('NVMe',  'Unknown'):  3_500 * 1024 * 1024,
    ('SATA',  'SSD'):        550 * 1024 * 1024,   # ~550 MB/s
    ('SAS',   'SSD'):       1000 * 1024 * 1024,   # ~1 GB/s
    ('SATA',  'HDD'):        150 * 1024 * 1024,   # 7200rpm, ~150 MB/s
    ('SAS',   'HDD'):        200 * 1024 * 1024,   # ~200 MB/s
    ('USB',   'SSD'):        400 * 1024 * 1024,   # USB 3.2-ish
    ('USB',   'HDD'):        100 * 1024 * 1024,   # USB 3.0-ish
    ('USB',   'Unknown'):    100 * 1024 * 1024,
}
_DISK_MAX_BPS_FALLBACK = 200 * 1024 * 1024  # 200 MB/s — generic spinning-disk-class default

# WMI BusType enum (subset relevant to consumer/server storage)
_WMI_BUS_TYPE = {
    1:  'SCSI',  2: 'ATAPI', 3:  'ATA',  4: '1394', 5:  'SSA',  6: 'FibreChannel',
    7:  'USB',   8: 'RAID',  9:  'iSCSI', 10: 'SAS', 11: 'SATA',
    14: 'MMC',  15: 'Virtual', 16: 'FileBackedVirtual', 17: 'NVMe',
}
_WMI_MEDIA_TYPE = {0: 'Unknown', 3: 'HDD', 4: 'SSD', 5: 'SCM'}


def _resolve_disk_hardware_max_bps() -> dict:
    """{drive_letter: max_bytes_per_sec} from MSFT_PhysicalDisk bus + media type.

    Walks root\\Microsoft\\Windows\\Storage disk -> partition -> volume to reach
    drive letters. {} on any failure — the caller falls back to the ratchet.
    """
    def _query():
        try:
            import pythoncom
            pythoncom.CoInitialize()
        except Exception:
            pass
        import wmi
        c = wmi.WMI(namespace='root/Microsoft/Windows/Storage')
        result = {}
        try:
            disks = c.MSFT_PhysicalDisk()
        except Exception:
            return {}
        disk_class = {}
        for d in disks:
            bus = _WMI_BUS_TYPE.get(int(getattr(d, 'BusType', 0) or 0), 'Unknown')
            media = _WMI_MEDIA_TYPE.get(int(getattr(d, 'MediaType', 0) or 0), 'Unknown')
            disk_class[str(getattr(d, 'DeviceId', ''))] = (bus, media)
        # Walk Disk -> Partition -> Volume to get drive letters
        try:
            partitions = c.MSFT_Partition()
        except Exception:
            return {}
        for part in partitions:
            # DriveLetter is a uint16 ASCII char code (0 when no letter is mounted)
            letter_code = int(getattr(part, 'DriveLetter', 0) or 0)
            if letter_code < ord('A') or letter_code > ord('Z'):
                continue
            letter = chr(letter_code)
            disk_num = str(getattr(part, 'DiskNumber', ''))
            cls = disk_class.get(disk_num)
            if not cls:
                continue
            max_bps = _DISK_MAX_BPS_BY_CLASS.get(cls, _DISK_MAX_BPS_FALLBACK)
            result[f'{letter}:'] = max_bps
        return result

    pool = ThreadPoolExecutor(max_workers=1)
    try:
        future = pool.submit(_query)
        try:
            return future.result(timeout=10.0)
        except FuturesTimeoutError:
            logging.warning('MSFT_PhysicalDisk hardware-class query timed out — disk maxBps will fall back to ratchet only')
            return {}
        except Exception as e:
            logging.warning(f'MSFT_PhysicalDisk hardware-class query failed: {e}')
            return {}
    finally:
        pool.shutdown(wait=False, cancel_futures=True)


def _disk_max_bps_for(volume_id: str, observed_bps: int) -> int:
    """max(hardware estimate for this volume, all-time observed peak).

    First call resolves the hardware map (one WMI query, ~300ms); after that it
    is cache + ratchet only.
    """
    global _disk_max_bps_hw_resolved
    with _disk_max_bps_lock:
        if not _disk_max_bps_hw_resolved:
            hw = _resolve_disk_hardware_max_bps()
            for vol, mb in hw.items():
                # Only seed if no observed peak is already higher.
                _disk_max_bps_cache[vol] = max(_disk_max_bps_cache.get(vol, 0), mb)
            _disk_max_bps_hw_resolved = True
        # Ratchet upward on a new peak.
        cached = _disk_max_bps_cache.get(volume_id, 0)
        if observed_bps > cached:
            cached = observed_bps
            _disk_max_bps_cache[volume_id] = cached
        # Floor: a 0 max would divide-by-zero downstream.
        return max(cached, _DISK_MAX_BPS_FALLBACK)


def _is_real_drive_letter(name: str) -> bool:
    """True for `C:`, `L:` — excludes WMI's `_Total` and `HarddiskVolumeN` raw
    partitions, which have no user-visible mapping.
    """
    return len(name) == 2 and name[0].isalpha() and name[1] == ':'


def get_disk_io_metrics():
    """Per-drive-letter disk IO via Win32_PerfFormattedData_PerfDisk_LogicalDisk.

    WMI perf counters need two internal samples to compute rates, so the first
    call after boot may return zeros. Only real drive letters are emitted.

    Returns {'<volume_id>': {readBps, writeBps (bytes/sec), readIops, writeIops
    (ops/sec), busyPct (100 - %IdleTime, clamped 0-100), maxBps (see
    _disk_max_bps_for)}}, or {} on WMI timeout/failure.
    """
    try:
        rows = _wmi_logical_disk_with_timeout()
        if rows is None:
            return {}

        result = {}
        for row in rows:
            name = row.get('Name', '')
            if not name or not _is_real_drive_letter(name):
                continue
            idle_pct = row.get('PercentIdleTime', 100.0)
            busy_pct = round(max(0.0, min(100.0 - idle_pct, 100.0)), 1)
            read_bps = row.get('DiskReadBytesPerSec', 0)
            write_bps = row.get('DiskWriteBytesPerSec', 0)
            max_bps = _disk_max_bps_for(name, max(read_bps, write_bps))
            result[name] = {
                'readBps': read_bps,
                'writeBps': write_bps,
                'readIops': row.get('DiskReadsPerSec', 0),
                'writeIops': row.get('DiskWritesPerSec', 0),
                'busyPct': busy_pct,
                'maxBps': max_bps,
            }
        return result

    except Exception as e:
        logging.warning(f"Error collecting disk IO metrics: {e}")
        return {}


# --- Network quality (ping-based) ---
_cached_gateway: str = ''
_cached_gateway_time: float = 0.0
_cached_ping_result: dict = {}
_ping_thread: threading.Thread = None


def _detect_default_gateway() -> str:
    """Detect default gateway IP via ipconfig."""
    global _cached_gateway, _cached_gateway_time
    now = time.time()
    # Cache gateway for 5 minutes
    if _cached_gateway and now - _cached_gateway_time < 300:
        return _cached_gateway
    try:
        output = subprocess.check_output(
            ['ipconfig'], text=True, timeout=5, creationflags=0x08000000
        )
        for line in output.splitlines():
            if 'Default Gateway' in line:
                parts = line.split(':')
                if len(parts) >= 2:
                    ip = parts[-1].strip()
                    if ip and not ip.startswith('fe80'):  # skip IPv6 link-local
                        _cached_gateway = ip
                        _cached_gateway_time = now
                        return ip
    except Exception:
        pass
    return ''


def _run_ping(target: str) -> dict:
    """Run ping and parse results. Returns {latency_ms, packet_loss_pct}."""
    try:
        output = subprocess.check_output(
            ['ping', '-n', '4', '-w', '1000', target],
            text=True, timeout=10, creationflags=0x08000000
        )
        # Parse packet loss: "(0% loss)" or "(25% loss)"
        packet_loss = 100.0
        for line in output.splitlines():
            if '% loss' in line or '% lost' in line:
                import re
                m = re.search(r'\((\d+)%', line)
                if m:
                    packet_loss = float(m.group(1))
                break

        # Parse average latency: "Average = 5ms"
        latency = -1.0
        for line in output.splitlines():
            if 'Average' in line or 'average' in line:
                import re
                m = re.search(r'(\d+)ms', line)
                if m:
                    latency = float(m.group(1))
                break

        return {
            'latency_ms': latency if latency >= 0 else None,
            'packet_loss_pct': packet_loss
        }
    except subprocess.TimeoutExpired:
        return {'latency_ms': None, 'packet_loss_pct': 100.0}
    except Exception:
        return {'latency_ms': None, 'packet_loss_pct': None}


def _ping_background():
    """Background thread that runs ping and caches result."""
    global _cached_ping_result
    try:
        gateway = _detect_default_gateway()
        if not gateway:
            _cached_ping_result = {'gateway_ip': None, 'latency_ms': None, 'packet_loss_pct': None}
            return
        result = _run_ping(gateway)
        _cached_ping_result = {
            'gateway_ip': gateway,
            'latency_ms': result.get('latency_ms'),
            'packet_loss_pct': result.get('packet_loss_pct'),
        }
    except Exception as e:
        logging.debug(f"Network quality ping failed: {e}")
        _cached_ping_result = {'gateway_ip': None, 'latency_ms': None, 'packet_loss_pct': None}


def get_network_quality() -> dict:
    """Get network quality metrics (latency + packet loss via ping to gateway).

    Runs ping in a background thread to avoid blocking the metrics loop (~4s for 4 pings).
    Returns cached result from previous ping cycle.
    """
    global _ping_thread
    if _ping_thread is None or not _ping_thread.is_alive():
        _ping_thread = threading.Thread(target=_ping_background, daemon=True)
        _ping_thread.start()
    return dict(_cached_ping_result) if _cached_ping_result else {
        'gateway_ip': None, 'latency_ms': None, 'packet_loss_pct': None
    }


def get_path(filename=None):
    """Path relative to this script (install dir) — icons, scripts, executables.
    For application data (config, logs, cache) use get_data_path().
    """
    path = os.path.dirname(os.path.realpath(__file__))

    if filename is not None:
        path = os.path.join(path, filename)

    path = os.path.normpath(path)

    return path

def get_python_exe_path():
    """Bundled interpreter: pythonw.exe if present (no console window), else
    python.exe. Raises FileNotFoundError if neither exists.
    """
    # src lives at <install>\agent\src — two levels up is the install root
    install_root = os.path.dirname(os.path.dirname(get_path()))

    pythonw_path = os.path.join(install_root, 'python', 'pythonw.exe')
    if os.path.exists(pythonw_path):
        return pythonw_path

    python_path = os.path.join(install_root, 'python', 'python.exe')
    if os.path.exists(python_path):
        return python_path

    raise FileNotFoundError(
        f"Python interpreter not found. Searched in: {os.path.join(install_root, 'python')}"
    )

def get_data_path(filename=None):
    """Absolute path under %PROGRAMDATA%\Owlette — where a Windows service is
    supposed to keep runtime data.

    get_data_path() -> C:\ProgramData\Owlette
    get_data_path('config/config.json') -> C:\ProgramData\Owlette\config\config.json
    """
    program_data = os.environ.get('PROGRAMDATA', 'C:\\ProgramData')
    owlette_data = os.path.join(program_data, 'Owlette')

    if filename is not None:
        path = os.path.join(owlette_data, filename)
    else:
        path = owlette_data

    path = os.path.normpath(path)

    return path

_SYSTEM_SID = 'S-1-5-18'


@functools.lru_cache(maxsize=None)
def _process_user_sid():
    """This process's token user as a string SID, or None if it cannot be read.

    Read once: a process token's user never changes for the life of the process.
    """
    try:
        import win32api
        import win32security

        token = win32security.OpenProcessToken(
            win32api.GetCurrentProcess(), win32security.TOKEN_QUERY
        )
        try:
            user_sid, _attributes = win32security.GetTokenInformation(
                token, win32security.TokenUser
            )
        finally:
            token.Close()
        return win32security.ConvertSidToStringSid(user_sid)
    except Exception as e:
        logging.warning(f"Could not read this process's token user: {e}")
        return None


def is_system_process():
    """True when this process runs as LocalSystem. An unreadable token counts as
    not SYSTEM, which creates and writes everything as a user process would."""
    return _process_user_sid() == _SYSTEM_SID


def ensure_data_directories():
    """Create the ProgramData directories. True if the base directories exist after.

    The cortex IPC trio is service-owned: only a SYSTEM process creates it,
    fail-closed, and a user-session process skips it.
    """
    directories = [
        get_data_path(),
        get_data_path('config'),
        get_data_path('logs'),
        get_data_path('cache'),
        get_data_path('tmp'),
        get_data_path('ipc'),
    ]

    try:
        for directory in directories:
            os.makedirs(directory, exist_ok=True)
    except Exception as e:
        logging.error(f"Failed to create data directories: {e}")
        return False

    if is_system_process():
        _create_cortex_ipc_dirs()
    return True


def _create_cortex_ipc_dirs():
    """Create the cortex IPC trio with acl_hardening's console-user DACL.

    An existing directory is adopted only when SYSTEM or Administrators owns it
    and it is not a reparse point; any other is logged and left alone.
    """
    aces = {os.path.normcase(entry.path): entry.aces for entry in acl_hardening.SPECS}
    for path in (CORTEX_IPC_CMD_DIR, CORTEX_IPC_RESULT_DIR, CORTEX_IPC_EVENTS_DIR):
        try:
            acl_hardening.create_private_dir(path, aces[os.path.normcase(path)])
        except acl_hardening.UntrustedDirectory as e:
            logging.warning(
                f"Cortex IPC: {e} (its owner is not SYSTEM or Administrators, or "
                f"it is a reparse point); the service's start-up repair sets the "
                f"DACL either way, but a directory keeps the owner that created it"
            )
        except Exception as e:
            logging.error(f"Cortex IPC: could not create {path}: {e}")

def get_environment():
    """'production' or 'development' from config; 'production' by default."""
    config = read_config()
    if config:
        return config.get('environment', 'production')
    return 'production'

def get_api_base_url(environment=None):
    """API base URL, e.g. 'https://owlette.app/api'. environment defaults to config."""
    if environment is None:
        environment = get_environment()

    if environment == 'development':
        return 'https://dev.owlette.app/api'
    else:
        return 'https://owlette.app/api'

def _without_trailing_slash(api_base):
    """api_base with one trailing slash dropped; anything else unchanged."""
    if isinstance(api_base, str) and api_base.endswith('/'):
        return api_base[:-1]
    return api_base

def is_owlette_api_base(api_base):
    """True only for the production and dev API bases, the hosts this agent sends
    credentials to. One trailing slash names the same base."""
    return _without_trailing_slash(api_base) in (
        get_api_base_url('production'), get_api_base_url('development'),
    )

def get_configured_api_base(config=None):
    """firebase.api_base when it is an owlette API base, else the environment's.

    Local users can edit config.json, so any other host there would receive this
    machine's refresh token. Reads from disk when config is None.
    """
    if config is None:
        config = read_config()
    configured = (config.get('firebase') or {}).get('api_base')
    if is_owlette_api_base(configured):
        # canonical form, so a caller's f'{base}/machines' keeps one slash.
        return _without_trailing_slash(configured)
    api_base = get_api_base_url(config.get('environment'))
    if configured:
        logging.warning(f"Ignoring firebase.api_base {configured!r}: not an owlette API base, using {api_base}")
    return api_base

def get_project_id(environment=None):
    """Firebase project ID. environment defaults to config."""
    if environment is None:
        environment = get_environment()

    if environment == 'development':
        return 'owlette-dev-3838a'
    else:
        return 'owlette-prod-90a12'

def get_web_host(environment=None):
    """Bare web host, e.g. 'owlette.app'. environment defaults to config."""
    if environment is None:
        environment = get_environment()

    if environment == 'development':
        return 'dev.owlette.app'
    else:
        return 'owlette.app'

def get_environment_label(environment=None):
    """Operator-facing environment name, e.g. 'production (owlette.app)'."""
    if environment is None:
        environment = get_environment()

    return f"{environment} ({get_web_host(environment)})"

# PATHS
CONFIG_PATH = get_data_path('config/config.json')
RESULT_FILE_PATH = get_data_path('tmp/app_states.json')

# DESKTOP APP (Tauri) — replaces owlette_tray.py and owlette_gui.py. Installed at
# {app}\app\owlette-desktop.exe. Two pid markers tell the service what the
# operator has open (writer: desktop/src-tauri/src/pid_file.rs):
#   tmp/tray.pid — whole process lifetime (tray icon present)
#   tmp/gui.pid  — only while the main window is on screen
DESKTOP_EXE_NAME = 'owlette-desktop.exe'
DESKTOP_TRAY_ARG = '--tray'
DESKTOP_RESTART_PROMPT_ARG = '--restart-prompt'
TRAY_PID_PATH = get_data_path('tmp/tray.pid')
GUI_PID_PATH = get_data_path('tmp/gui.pid')


def get_desktop_exe_path():
    """Full path to the desktop app, or None when not installed. Resolved from
    the install root like get_python_exe_path(), so a relocated install works.
    """
    install_root = os.path.dirname(os.path.dirname(get_path()))
    candidate = os.path.join(install_root, 'app', DESKTOP_EXE_NAME)
    return candidate if os.path.exists(candidate) else None


def build_detached_launch_command(exe_path, args=()):
    """Command line that launches exe_path *outside* the service's process tree.

    Under 2.x NSSM stopped the service by killing its whole process tree, which
    took the operator's tray icon with it — and NSSM 2.24 ignored the
    AppKillProcessTree=0 the installer set. ``cmd.exe /c start`` breaks the link:
    cmd exits immediately, so the recorded parent is gone before anything walks
    the tree. The empty ``""`` is the window title ``start`` would otherwise take
    the quoted path for.

    owlette-host (3.0.0) never kills descendants, but this stays: a manual
    ``taskkill /T`` or a remote-management tool still walks the tree.

    The PID is lost in the handoff (the caller gets cmd's), so callers must read
    it back from ``read_desktop_pid(TRAY_PID_PATH)``.
    """
    quoted = ' '.join(f'"{argument}"' for argument in args)
    return f'cmd.exe /c start "" "{exe_path}"{" " + quoted if quoted else ""}'


def read_desktop_pid(pid_path):
    """PID from pid_path, but only if it is a live owlette-desktop.exe.

    A python-image cmdline scan can't be used — it only matches "python" image names.
    Checking the image name as well as the PID is what stops a recycled PID from
    reading as a live UI. None when the marker is absent, stale or foreign.
    """
    try:
        with open(pid_path, 'r') as f:
            pid = int(f.read().strip())
    except (OSError, ValueError):
        return None

    if pid <= 0 or not psutil.pid_exists(pid):
        return None

    try:
        if (psutil.Process(pid).name() or '').lower() == DESKTOP_EXE_NAME:
            return pid
    except (psutil.NoSuchProcess, psutil.AccessDenied):
        pass
    return None


def is_desktop_window_open():
    """True while the operator has the desktop app's main window on screen."""
    return read_desktop_pid(GUI_PID_PATH) is not None

# Lazy GPUtil import — eager probing at module load costs ~5-10 MB plus startup
# delay for every importer. Failures are sticky only for _GPUTIL_RETRY_BACKOFF so
# a transient error during a driver update recovers on its own.
_gputil_module = None
_gputil_retry_after = 0.0  # monotonic seconds; 0 = retry immediately
_gputil_popen_patched = False
_GPUTIL_RETRY_BACKOFF = 300.0  # 5 min between retries after a failed import

def _ensure_gputil_no_window_popen_patched():
    global _gputil_popen_patched
    if _gputil_popen_patched:
        return
    if sys.platform != 'win32':
        _gputil_popen_patched = True
        return

    try:
        import GPUtil.GPUtil as _gputil_impl

        def _wrap_popen(original_popen):
            if getattr(original_popen, '_owlette_create_no_window', False):
                return original_popen

            def _popen_no_window(*args, **kwargs):
                kwargs['creationflags'] = (
                    (kwargs.get('creationflags') or 0)
                    | subprocess.CREATE_NO_WINDOW
                )
                return original_popen(*args, **kwargs)

            _popen_no_window._owlette_create_no_window = True
            _popen_no_window._owlette_original_popen = original_popen
            return _popen_no_window

        patched_targets = []

        popen = getattr(_gputil_impl, 'Popen', None)
        if popen is not None:
            _gputil_impl.Popen = _wrap_popen(popen)
            patched_targets.append('GPUtil.GPUtil.Popen')

        gputil_subprocess = getattr(_gputil_impl, 'subprocess', None)
        subprocess_popen = getattr(gputil_subprocess, 'Popen', None)
        if subprocess_popen is not None:
            class _SubprocessProxy:
                def __init__(self, module, popen_wrapper):
                    self._module = module
                    self.Popen = popen_wrapper

                def __getattr__(self, name):
                    return getattr(self._module, name)

            _gputil_impl.subprocess = _SubprocessProxy(
                gputil_subprocess,
                _wrap_popen(subprocess_popen),
            )
            patched_targets.append('GPUtil.GPUtil.subprocess.Popen')

        if patched_targets:
            logging.debug(
                "Patched GPUtil Popen for hidden Windows launches: %s",
                ", ".join(patched_targets),
            )
        else:
            logging.debug(
                "GPUtil Popen patch warning: no supported Popen reference found"
            )
    except Exception as e:
        logging.debug(
            "GPUtil Popen patch warning: failed to apply hidden Windows launch: %s",
            e,
            exc_info=True,
        )
    finally:
        _gputil_popen_patched = True

def _get_gputil():
    global _gputil_module, _gputil_retry_after
    if _gputil_module is not None:
        return _gputil_module
    if time.monotonic() < _gputil_retry_after:
        return None
    try:
        import GPUtil as _g
        _ensure_gputil_no_window_popen_patched()
        _gputil_module = _g
        return _gputil_module
    except Exception:
        _gputil_retry_after = time.monotonic() + _GPUTIL_RETRY_BACKOFF
        return None

# mtime-invalidated config cache: read_config() runs several times per 5s tick
# across three threads. Semantics are unchanged — external edits land as soon as
# the OS publishes the new mtime, in-process writes invalidate directly.
import copy as _copy
_config_cache_lock = threading.Lock()
_config_cache_mtime = 0.0
_config_cache_data = None

def _read_config_cached():
    """Return the parsed config.json, using an mtime-invalidated cache.

    Returns a deep copy so callers can safely mutate the result without
    corrupting the shared cache entry.
    """
    global _config_cache_mtime, _config_cache_data
    try:
        mtime = os.path.getmtime(CONFIG_PATH)
    except OSError:
        # Missing — the raw reader has its own not-found and retry handling.
        return read_json_from_file(CONFIG_PATH)

    with _config_cache_lock:
        if _config_cache_data is not None and mtime == _config_cache_mtime:
            return _copy.deepcopy(_config_cache_data)

    data = read_json_from_file(CONFIG_PATH)
    with _config_cache_lock:
        _config_cache_mtime = mtime
        _config_cache_data = data
    return _copy.deepcopy(data)

def _invalidate_config_cache(new_data=None):
    """Reset the config cache. Call after any in-process write to config.json."""
    global _config_cache_mtime, _config_cache_data
    with _config_cache_lock:
        _config_cache_mtime = 0.0
        _config_cache_data = _copy.deepcopy(new_data) if new_data is not None else None

# Cortex (local AI agent) paths
CORTEX_PID_PATH = get_data_path('tmp/cortex.pid')
CORTEX_IPC_CMD_DIR = get_data_path('ipc/cortex_commands')
CORTEX_IPC_RESULT_DIR = get_data_path('ipc/cortex_results')
CORTEX_IPC_EVENTS_DIR = get_data_path('ipc/cortex_events')


def is_cortex_enabled(config=None):
    """True if cortex.enabled is truthy. Reads from disk when config is None."""
    if config is None:
        config = read_config()
    return bool(config.get('cortex', {}).get('enabled', False))

# LOGGING
def get_log_level_from_config():
    """logging.* level constant from config.json; INFO if missing or invalid."""
    try:
        level_str = read_config(['logging', 'level'])
        if not level_str:
            return logging.INFO

        level_map = {
            'DEBUG': logging.DEBUG,
            'INFO': logging.INFO,
            'WARNING': logging.WARNING,
            'ERROR': logging.ERROR,
            'CRITICAL': logging.CRITICAL
        }

        return level_map.get(level_str.upper(), logging.INFO)
    except Exception as e:
        return logging.INFO

def cleanup_old_logs(max_age_days=90):
    """Delete log files older than max_age_days. Returns the count deleted."""
    try:
        import time
        log_dir = get_data_path('logs')

        if not os.path.exists(log_dir):
            return 0

        cutoff_time = time.time() - (max_age_days * 24 * 60 * 60)
        deleted_count = 0
        total_size_freed = 0

        for filename in os.listdir(log_dir):
            file_path = os.path.join(log_dir, filename)

            if not os.path.isfile(file_path):
                continue

            if not (filename.endswith('.log') or '.log.' in filename):
                continue

            file_mtime = os.path.getmtime(file_path)
            if file_mtime < cutoff_time:
                try:
                    file_size = os.path.getsize(file_path)
                    os.remove(file_path)
                    deleted_count += 1
                    total_size_freed += file_size
                    logging.debug(f"Deleted old log file: {filename} ({round(file_size / 1024 / 1024, 2)} MB)")
                except Exception as e:
                    logging.warning(f"Could not delete old log file {filename}: {e}")

        if deleted_count > 0:
            mb_freed = round(total_size_freed / 1024 / 1024, 2)
            logging.info(f"[OK] Log cleanup complete: {deleted_count} file(s) deleted, {mb_freed} MB freed")

        return deleted_count

    except Exception as e:
        logging.error(f"Error during log cleanup: {e}")
        return 0

# 2 MB is generous for one installer run and caps the on-disk worst case
# (current + .1) at ~4 MB.
EXTERNAL_LOG_MAX_BYTES = 2 * 1024 * 1024


def rotate_log_if_oversized(log_path, max_bytes=EXTERNAL_LOG_MAX_BYTES):
    """Rotate ONCE (``<name>`` -> ``<name>.1``) when the file exceeds max_bytes.

    For logs an external process appends to forever — the Inno Setup installer's
    ``/LOG=`` file — which our RotatingFileHandler doesn't cover and
    cleanup_old_logs never ages out (every update refreshes the mtime).

    Deliberately dumb: one rename, no handlers, no locks — this log must survive
    the upgrade it documents. Never raises. True if a rotation happened.
    """
    try:
        if not os.path.exists(log_path):
            return False
        size = os.path.getsize(log_path)
        if size <= max_bytes:
            return False
        # os.replace overwrites .1 atomically — exactly one generation, never a chain.
        os.replace(log_path, f"{log_path}.1")
        logging.info(
            f"Rotated oversized log {os.path.basename(log_path)} "
            f"({round(size / 1024 / 1024, 2)} MB) to .1"
        )
        return True
    except Exception as e:
        # An unrotated log is a disk-space annoyance; failing the caller (an
        # in-progress agent update) would be far worse.
        logging.warning(f"Could not rotate log {log_path}: {e}")
        return False


def get_log_tail(log_name='service', lines=100):
    """Read the last N lines from a log file. Returns empty string on failure."""
    try:
        log_path = get_data_path(f'logs/{log_name}.log')
        if not os.path.exists(log_path):
            return ''
        with open(log_path, 'r', encoding='utf-8', errors='replace') as f:
            all_lines = f.readlines()
            return ''.join(all_lines[-lines:])
    except Exception as e:
        logging.warning(f"Failed to read log tail: {e}")
        return ''


def initialize_logging(log_file_name, level=logging.INFO):
    # the handler opens its file at once, so logs\ comes first; the other
    # directories are created after it so what their creation logs (an
    # untrusted cortex ipc directory) lands in this file, not on stderr.
    os.makedirs(get_data_path('logs'), exist_ok=True)

    log_file_path = get_data_path(f'logs/{log_file_name}.log')

    log_formatter = logging.Formatter('%(asctime)s - %(levelname)s - %(message)s')

    # mode='a': never truncate — history is what crash triage runs on.
    # 60 MB retention (current + 5 x 10 MB). encoding='utf-8' because Windows
    # defaults to cp1252 and non-ASCII log content (the '→' in several status
    # messages) would raise UnicodeEncodeError; errors='backslashreplace' makes
    # the handler uncrashable. Matches get_log_tail() and the cortex.log handler.
    log_handler = RotatingFileHandler(log_file_path, mode='a', maxBytes=10*1024*1024, backupCount=5, encoding='utf-8', errors='backslashreplace', delay=0)

    log_handler.setFormatter(log_formatter)

    logger = logging.getLogger()
    logger.setLevel(level)
    logger.addHandler(log_handler)

    _log_startup_banner(level, log_file_path)
    ensure_data_directories()


def _get_windows_version_string():
    """Return friendly Windows version e.g. 'Windows 11 Pro 23H2 (Build 22631)'.
    Falls back to platform.version() if registry read fails."""
    try:
        key = winreg.OpenKey(winreg.HKEY_LOCAL_MACHINE,
                             r'SOFTWARE\Microsoft\Windows NT\CurrentVersion')
        product = winreg.QueryValueEx(key, 'ProductName')[0]
        display = winreg.QueryValueEx(key, 'DisplayVersion')[0]
        build   = winreg.QueryValueEx(key, 'CurrentBuildNumber')[0]
        winreg.CloseKey(key)
        return f"{product} {display} (Build {build})"
    except Exception:
        return platform.version()


def _log_startup_banner(level, log_file_path):
    """Rich startup banner logged immediately after logging is configured."""
    import sys
    sep = "=" * 70
    logging.info(sep)
    logging.info(f"  OWLETTE AGENT STARTING - v{APP_VERSION}")
    logging.info(sep)
    logging.info(f"  Hostname     : {get_hostname()}")
    logging.info(f"  Timezone     : {get_machine_timezone() or 'unknown'}")
    logging.info(f"  Environment  : {get_environment()}")
    logging.info(f"  API base     : {get_api_base_url()}")
    logging.info(f"  Python       : {sys.version.split()[0]}  ({sys.executable})")
    logging.info(f"  Windows      : {_get_windows_version_string()}")
    logging.info(f"  Install path : {get_path()}")
    logging.info(f"  Data path    : {get_data_path()}")
    logging.info(f"  Log file     : {log_file_path}")
    logging.info(f"  Log level    : {logging.getLevelName(level)}")
    logging.info(sep)


def log_startup_system_snapshot():
    """Log CPU, RAM, disk, GPU, and IP info at startup. Non-fatal if anything fails."""
    try:
        cpu_name = get_cpu_name()
        cpu_logical = psutil.cpu_count(logical=True)
        cpu_physical = psutil.cpu_count(logical=False)
        mem_gb = round(psutil.virtual_memory().total / (1024 ** 3), 1)

        try:
            sys_disk = psutil.disk_usage('C:\\')
            disk_str = f"{round(sys_disk.free / (1024**3), 1)} GB free of {round(sys_disk.total / (1024**3), 1)} GB"
        except Exception:
            disk_str = "unavailable"

        ips = _get_primary_ips()

        sep = "-" * 70
        logging.info(sep)
        logging.info("  SYSTEM SNAPSHOT")
        logging.info(sep)
        logging.info(f"  CPU          : {cpu_name}")
        logging.info(f"  Cores        : {cpu_physical} physical / {cpu_logical} logical")
        logging.info(f"  RAM          : {mem_gb} GB total")
        logging.info(f"  Disk (C:\\)   : {disk_str}")
        try:
            _g = _get_gputil()
            gpus = _g.getGPUs() if _g else []
            if gpus:
                for i, gpu in enumerate(gpus):
                    vram_gb = round(gpu.memoryTotal / 1024, 1)
                    logging.info(f"  GPU {i}         : {gpu.name}  ({vram_gb} GB VRAM)")
            else:
                logging.info("  GPU           : none detected")
        except Exception:
            logging.info("  GPU           : detection failed")
        logging.info(f"  IP address(es): {', '.join(ips) if ips else 'unavailable'}")
        logging.info(sep)
    except Exception as e:
        logging.warning(f"System snapshot failed (non-fatal): {e}")


def _get_primary_ips():
    """Return list of non-loopback IPv4 addresses."""
    ips = []
    try:
        for _iface, addrs in psutil.net_if_addrs().items():
            for addr in addrs:
                if addr.family == socket.AF_INET and not addr.address.startswith('127.'):
                    ips.append(addr.address)
    except Exception:
        pass
    return ips


def log_watchdog_restart_block(snapshot: dict):
    """Log a visually distinct banner when the self-restart watchdog fires.

    Tagged [WATCHDOG-RESTART] for easy grep across rotated log files. Also
    emits a single [WATCHDOG-JSON] line with the full snapshot for machine
    parsing (jq / Loki / ELK).
    """
    try:
        sep = "=" * 70
        logging.info(sep)
        logging.info("  [WATCHDOG-RESTART] INITIATING PROCESS EXIT FOR SELF-RECOVERY")
        logging.info(sep)
        logging.info(f"  Reason code        : {snapshot.get('reason_code', 'unknown')}")
        logging.info(f"  Seconds since OK   : {snapshot.get('seconds_since_last_success', 'n/a')}")
        logging.info(f"  Consecutive fails  : {snapshot.get('consecutive_failures', 'n/a')}")
        logging.info(f"  Internet (TCP)     : {snapshot.get('internet_check_tcp', 'n/a')}")
        logging.info(f"  Last error         : {snapshot.get('last_error', 'n/a')}")
        logging.info(f"  Process uptime (s) : {snapshot.get('process_uptime_s', 'n/a')}")
        logging.info(f"  Restarts in window : {snapshot.get('restart_count_in_window', 'n/a')}")
        logging.info(f"  Restart ID         : {snapshot.get('restart_id', 'n/a')}")
        logging.info(f"  Timestamp (UTC)    : {snapshot.get('timestamp_utc', 'n/a')}")
        logging.info(sep)
        logging.info("[WATCHDOG-JSON] " + json.dumps(snapshot, default=str))
    except Exception as e:
        logging.error(f"log_watchdog_restart_block failed: {e}")


def log_watchdog_restart_replay(snapshot: dict):
    """Log a block on startup when the previous process exited via watchdog."""
    try:
        sep = "-" * 70
        logging.info(sep)
        logging.info("  [WATCHDOG-RESTART REPLAY] previous process exited via self-restart watchdog")
        logging.info(sep)
        logging.info(f"  Reason code        : {snapshot.get('reason_code', 'unknown')}")
        logging.info(f"  Restart ID         : {snapshot.get('restart_id', 'n/a')}")
        logging.info(f"  Timestamp (UTC)    : {snapshot.get('timestamp_utc', 'n/a')}")
        logging.info(f"  Seconds since OK   : {snapshot.get('seconds_since_last_success', 'n/a')}")
        logging.info(f"  Last error         : {snapshot.get('last_error', 'n/a')}")
        logging.info(f"  Submitted          : {'yes' if snapshot.get('submitted_at') else 'pending firestore submission'}")
        logging.info(sep)
    except Exception as e:
        logging.warning(f"log_watchdog_restart_replay failed (non-fatal): {e}")


def log_startup_config_summary():
    """Log key config values at startup. Non-fatal if config unreadable."""
    try:
        config = read_config()
        if not config:
            logging.warning("Config summary: config.json not readable")
            return
        fb = config.get('firebase', {})
        lg = config.get('logging', {})
        sep = "-" * 70
        logging.info(sep)
        logging.info("  CONFIG SUMMARY")
        logging.info(sep)
        logging.info(f"  Firebase enabled : {fb.get('enabled', False)}")
        logging.info(f"  Site ID          : {fb.get('site_id', 'not set')}")
        logging.info(f"  Log level (cfg)  : {lg.get('level', 'INFO')}")
        logging.info(f"  Processes        : {len(config.get('processes', []))} configured")
        logging.info(f"  Cortex enabled   : {config.get('cortex', {}).get('enabled', False)}")
        logging.info(sep)
    except Exception as e:
        logging.warning(f"Config summary failed (non-fatal): {e}")


class FirebaseLogHandler(logging.Handler):
    """Ships log records to Firestore for centralized multi-agent monitoring."""
    def __init__(self, firebase_client, errors_only=True):
        """errors_only: ship only ERROR and CRITICAL."""
        super().__init__()
        self.firebase_client = firebase_client
        self.errors_only = errors_only
        self.buffer = []
        self.max_buffer_size = 50

    def emit(self, record):
        """Buffer a log record for shipping to Firebase."""
        try:
            if self.errors_only and record.levelno < logging.ERROR:
                return

            log_entry = {
                'timestamp': record.created,
                'level': record.levelname,
                'message': self.format(record),
                'logger': record.name,
                'filename': record.filename,
                'line': record.lineno
            }

            self.buffer.append(log_entry)

            # CRITICAL ships immediately; everything else batches.
            if record.levelno >= logging.CRITICAL or len(self.buffer) >= self.max_buffer_size:
                self.flush()

        except Exception:
            # A logging failure must never crash the app.
            self.handleError(record)

    def flush(self):
        """Ship buffered logs to Firebase."""
        if not self.buffer or not self.firebase_client:
            return

        try:
            self.firebase_client.ship_logs(self.buffer.copy())
            self.buffer.clear()
        except Exception:
            # A logging failure must never crash the app.
            pass

def add_firebase_log_handler(firebase_client):
    """Attach the Firestore log handler to the root logger, if config enables it."""
    try:
        shipping_config = read_config(['logging', 'firebase_shipping'])
        if not shipping_config or not shipping_config.get('enabled', False):
            return

        errors_only = shipping_config.get('ship_errors_only', True)

        firebase_handler = FirebaseLogHandler(firebase_client, errors_only=errors_only)
        firebase_handler.setFormatter(logging.Formatter('%(asctime)s - %(levelname)s - %(message)s'))

        logger = logging.getLogger()
        logger.addHandler(firebase_handler)

        logging.info(f"[OK] Firebase log shipping enabled (errors_only: {errors_only})")

    except Exception as e:
        logging.warning(f"Could not enable Firebase log shipping: {e}")

# CONFIG JSON

def load_config():
    try:
        config = read_json_from_file(CONFIG_PATH)
        return config
        
    except FileNotFoundError as e:
        logging.error(f"Failed to load config: {e}")
        return generate_config_file()

def save_config(config=None):
    if config is None:
        config = read_json_from_file(CONFIG_PATH)

    # Strip runtime-only fields before persisting — these belong in app_states.json, not config
    for process in config.get('processes', []):
        process.pop('status', None)

    write_json_to_file(config, CONFIG_PATH)
  
# Migrate config.json forward from any version < CONFIG_VERSION.
def upgrade_config():
    config = read_json_from_file(CONFIG_PATH)
    if config:
        current_version = config.get('version', '0.0.0')

        if version.parse(current_version) < version.parse(CONFIG_VERSION):
            config['version'] = CONFIG_VERSION

            for process in config['processes']:
                if 'autostart_process' in process:
                    process['autolaunch'] = process.pop('autostart_process')
                elif 'autolaunch_process' in process:
                    process['autolaunch'] = process.pop('autolaunch_process')

                # Ensure all necessary keys are in each process object
                for key in ['id', 'name', 'exe_path', 'file_path', 'cwd', 'time_delay', 'time_to_init', 'relaunch_attempts', 'autolaunch', 'visibility', 'priority']:
                    if key == 'visibility':
                        process.setdefault(key, 'Show')
                    elif key == 'priority':
                        process.setdefault(key, 'Normal')
                    elif key == 'cwd':
                        process.setdefault(key, None)
                    else:
                        process.setdefault(key, '')

            # Add logging configuration if missing (v1.4.0+)
            if 'logging' not in config:
                config['logging'] = {
                    "level": "INFO",
                    "max_age_days": 90,
                    "firebase_shipping": {
                        "enabled": False,
                        "ship_errors_only": True
                    }
                }
                logging.info("Added logging configuration to config.json (v1.4.0)")

            # Add environment if missing (v1.5.0+), inferred from api_base
            if 'environment' not in config:
                existing_api_base = config.get('firebase', {}).get('api_base', '')
                if 'dev.owlette.app' in existing_api_base:
                    config['environment'] = 'development'
                else:
                    config['environment'] = 'production'
                logging.info(f"Added environment configuration to config.json (v1.5.0): {config['environment']}")

            # Migrate autolaunch → launch_mode (v1.6.0+)
            for process in config.get('processes', []):
                if 'launch_mode' not in process:
                    if process.get('autolaunch', False):
                        process['launch_mode'] = 'always'
                    else:
                        process['launch_mode'] = 'off'
                    logging.info(f"Migrated process '{process.get('name', '?')}' autolaunch={process.get('autolaunch')} -> launch_mode={process['launch_mode']}")
                # Always derive autolaunch for backward compat with older agents
                process['autolaunch'] = process.get('launch_mode', 'off') != 'off'
                if 'schedules' not in process:
                    process['schedules'] = None

            # 'version' first
            ordered_config = {'version': config['version']}
            for key in config:
                if key != 'version':
                    ordered_config[key] = config[key]

            write_json_to_file(ordered_config, CONFIG_PATH)

        # Temperature toggle backfill (v1.7.0) — deliberately OUTSIDE the
        # version gate: a remote config pull wholesale-replaces config.json
        # (owlette_service.handle_config_update) and can drop the section
        # until the cloud doc carries it. Readers treat a missing key as
        # enabled (`is False` sentinel) so behavior never changes; this just
        # keeps the toggle visible/editable and lets startup sync push it to
        # Firestore. Idempotent — one dict lookup per boot once present.
        if 'temperature' not in config:
            config['temperature'] = {"enabled": True}
            ordered_config = {'version': config['version']}
            for key in config:
                if key != 'version':
                    ordered_config[key] = config[key]
            write_json_to_file(ordered_config, CONFIG_PATH)
            logging.info("Added temperature configuration to config.json (v1.7.0)")

    else:
        # CRITICAL: an existing-but-unreadable config (file lock) must NOT be
        # regenerated — that wipes the firebase section and unregisters the agent.
        if os.path.exists(CONFIG_PATH):
            logging.warning(f"Config file exists but couldn't be read (file lock?). Skipping upgrade.")
            logging.warning("If this persists, check file permissions and locks.")
            return

        logging.info("Config file doesn't exist, generating default...")
        new_config = generate_config_file()
        write_json_to_file(new_config, CONFIG_PATH)

# Schedule utility for launch_mode='scheduled'
def is_within_schedule(schedules, timezone_str=None):
    """True if now falls in ANY schedule block's window, or if schedules is
    empty (safety fallback). timezone_str is IANA; local time when None.
    """
    if not schedules:
        return True  # No schedules = always active (safety fallback)

    from datetime import datetime, time as dt_time
    try:
        from zoneinfo import ZoneInfo
    except ImportError:
        from backports.zoneinfo import ZoneInfo

    try:
        tz = ZoneInfo(timezone_str) if timezone_str else None
    except (KeyError, Exception):
        logging.warning(f"Invalid timezone '{timezone_str}', falling back to local time")
        tz = None
    now = datetime.now(tz)
    day_names = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun']
    current_day = day_names[now.weekday()]
    current_time = now.time()

    prev_day = day_names[(day_names.index(current_day) - 1) % 7]

    for block in schedules:
        days = block.get('days', day_names)
        for time_range in block.get('ranges', []):
            try:
                start_h, start_m = map(int, time_range['start'].split(':'))
                stop_h, stop_m = map(int, time_range['stop'].split(':'))
            except (ValueError, KeyError):
                continue
            start = dt_time(start_h, start_m)
            stop = dt_time(stop_h, stop_m)
            if start <= stop:
                if current_day in days and start <= current_time <= stop:
                    return True
            else:
                # Overnight (e.g. 22:00-01:00). Before midnight: today scheduled.
                if current_day in days and current_time >= start:
                    return True
                # After midnight: the *previous* day must be scheduled.
                if prev_day in days and current_time <= stop:
                    return True
    return False


def compute_scheduled_instant(date_obj, time_str, timezone_str=None):
    """Timezone-aware datetime for date_obj + time_str ("HH:MM", 24h).

    The reboot scheduler uses this to compare an entry's {date, time} against now
    and boot_time. timezone_str is IANA; local time when None. None if time_str is
    malformed. Across a DST forward jump the result is the closest valid post-gap
    instant (zoneinfo default) — the entry fires just after the gap.
    """
    from datetime import datetime, time as dt_time
    try:
        from zoneinfo import ZoneInfo
    except ImportError:
        from backports.zoneinfo import ZoneInfo

    try:
        h, m = map(int, time_str.split(':'))
        wall_time = dt_time(h, m)
    except (ValueError, AttributeError):
        return None

    try:
        tz = ZoneInfo(timezone_str) if timezone_str else None
    except (KeyError, Exception):
        logging.warning(f"Invalid timezone '{timezone_str}', falling back to local time")
        tz = None

    naive = datetime.combine(date_obj, wall_time)
    return naive.replace(tzinfo=tz) if tz else naive.astimezone()


def read_json_from_file(file_path, max_retries=3, initial_delay=0.1):
    """Read JSON, retrying past cross-process file locks.

    initial_delay doubles per attempt. Returns {} on any error or missing file —
    never None, because callers index the result unguarded.
    """
    with _CrossProcessLock(), json_lock:
        for attempt in range(max_retries):
            try:
                with open(file_path, 'r') as f:
                    content = f.read().strip()
                    if not content:
                        logging.debug(f"{file_path} is empty, returning empty dict")
                        return {}
                    data = json.loads(content)
                    return data

            except FileNotFoundError:
                logging.debug(f"{file_path} not found, returning empty dict")
                return {}

            except json.JSONDecodeError as e:
                logging.error(f"Failed to decode JSON from {file_path}: {e}")
                return {}

            except PermissionError as e:
                # Locked by another process — back off and retry.
                if attempt < max_retries - 1:
                    delay = initial_delay * (2 ** attempt)  # 0.1s, 0.2s, 0.4s
                    logging.warning(f"File locked during read, retrying in {delay}s... (attempt {attempt + 1}/{max_retries}): {e}")
                    time.sleep(delay)
                else:
                    logging.error(f"Failed to read after {max_retries} attempts (file locked): {e}")
                    return {}

            except Exception as e:
                logging.error(f"An error occurred while reading the file {file_path}: {e}")
                return {}

        return {}  # All retries exhausted

# app_states.json is also replaced by user-session writers (the desktop app,
# owlette_scout), so its dacl keeps modify for the console user. config.json
# keeps its directory's inherited acl: the console user edits it (desktop app,
# pairing) by replacing the file, which a read-only dacl would refuse. both are
# the import-time paths, so a test that redirects the module constants writes
# as it always did.
_CONSOLE_WRITABLE_JSON = os.path.normcase(RESULT_FILE_PATH)
_USER_EDITED_JSON = os.path.normcase(CONFIG_PATH)

# files whose dacl step has already failed once; later failures log at debug.
_json_dacl_failures = set()


def _json_file_dacl(file_path):
    """The protected DACL a writer gives file_path, or None to leave the file
    its directory's inherited ACL.

    A SYSTEM writer protects every file but config.json: SYSTEM and
    Administrators full, Users read, and the console user modify on
    app_states.json. A user-session writer protects app_states.json only, with
    modify for itself (it is the console user), so its write does not reopen the
    file to every local account.
    """
    path = os.path.normcase(file_path)
    if path == _USER_EDITED_JSON:
        return None
    console_writable = path == _CONSOLE_WRITABLE_JSON
    if is_system_process():
        modify_sid = acl_hardening.console_user_sid() if console_writable else None
    elif console_writable and _process_user_sid() is not None:
        import win32security
        modify_sid = win32security.ConvertStringSidToSid(_process_user_sid())
    else:
        return None

    import ntsecuritycon as ntc
    dacl = [
        (acl_hardening.SID_SYSTEM, ntc.FILE_ALL_ACCESS, 0),
        (acl_hardening.SID_ADMINISTRATORS, ntc.FILE_ALL_ACCESS, 0),
        (acl_hardening.SID_USERS, ntc.FILE_GENERIC_READ, 0),
    ]
    if modify_sid is not None:
        modify = (
            ntc.FILE_GENERIC_READ | ntc.FILE_GENERIC_WRITE
            | ntc.FILE_GENERIC_EXECUTE | ntc.DELETE
        )
        dacl.append((modify_sid, modify, 0))
    return dacl


def _write_new_file_with_dacl(path, payload, dacl, dacl_first=False):
    """Create path, which must not exist yet, write payload and set dacl as its
    protected DACL, all through one handle that shares nothing.

    No other process can open the file between its creation and the DACL, and
    an open handle keeps the access it was granted, so the DACL is set on this
    handle rather than by name after the close. A link at path counts as an
    existing file, so nothing is ever created where a link points. Raises
    OSError as open() would when the file cannot be created, and AclApplyError
    when only the DACL step failed (the file exists either way).

    dacl_first sets the DACL before the first byte, so a DACL failure leaves an
    empty file and the payload nowhere on disk — what the token store needs.
    Without it the payload stands and only the DACL step is reported, which is
    what the status files need: their write must not depend on it.
    """
    import pywintypes
    import win32con
    import win32file
    import win32security

    try:
        handle = win32file.CreateFile(
            path, win32file.GENERIC_WRITE | win32con.WRITE_DAC, 0, None,
            win32file.CREATE_NEW,
            win32file.FILE_ATTRIBUTE_NORMAL | win32file.FILE_FLAG_OPEN_REPARSE_POINT,
            None,
        )
    except pywintypes.error as e:
        # the winerror picks the OSError subclass, so a sharing violation
        # retries like any other lock.
        raise OSError(0, e.strerror, path, e.winerror) from e
    try:
        if not dacl_first:
            win32file.WriteFile(handle, payload)
        try:
            acl = win32security.ACL()
            for sid, mask, flags in dacl:
                acl.AddAccessAllowedAceEx(win32security.ACL_REVISION, flags, mask, sid)
            win32security.SetSecurityInfo(
                handle, win32security.SE_FILE_OBJECT,
                win32security.DACL_SECURITY_INFORMATION
                | win32security.PROTECTED_DACL_SECURITY_INFORMATION,
                None, None, acl, None,
            )
        except Exception as e:
            raise acl_hardening.AclApplyError(
                f"failed to apply DACL to {path}: {e}"
            ) from e
        if dacl_first:
            win32file.WriteFile(handle, payload)
    finally:
        handle.Close()


def _write_protected_temp(temp_path, file_path, data, dacl):
    """Write data to temp_path as a file this process creates, carrying dacl.

    A leftover or planted temp file is removed first: whoever created a file
    owns it, and its owner can rewrite any DACL set on it. A DACL failure is
    non-fatal: the write stands with the inherited ACL, logged once per file.
    """
    # the bytes open(..., 'w') + json.dump write: ascii, platform line endings.
    payload = json.dumps(data, indent=4).replace('\n', os.linesep).encode('ascii')
    try:
        os.remove(temp_path)
    except FileNotFoundError:
        pass
    try:
        _write_new_file_with_dacl(temp_path, payload, dacl)
    except acl_hardening.AclApplyError as e:
        if file_path in _json_dacl_failures:
            logging.debug(f"{e}; {file_path} keeps its inherited permissions")
        else:
            _json_dacl_failures.add(file_path)
            logging.warning(f"{e}; {file_path} keeps its inherited permissions")


def write_json_to_file(data, file_path, max_retries=3, initial_delay=0.1):
    """Atomically write JSON (temp file + replace), retrying past file locks.

    initial_delay doubles per attempt. A caller that passes max_retries=1
    retries on its own schedule, so its lock is logged at debug, not error.
    When _json_file_dacl gives the file a DACL, the temp file carries it before
    the rename, so the replaced file never inherits its directory's
    user-writable ACL.
    """
    with _CrossProcessLock(), json_lock:
        temp_path = file_path + '.tmp'
        dacl = _json_file_dacl(file_path)

        for attempt in range(max_retries):
            try:
                if dacl is None:
                    with open(temp_path, 'w') as f:
                        json.dump(data, f, indent=4)
                else:
                    _write_protected_temp(temp_path, file_path, data, dacl)

                # os.replace is atomic on Windows; os.rename is not.
                os.replace(temp_path, file_path)

                return

            except PermissionError as e:
                # Locked by another process — back off and retry.
                if attempt < max_retries - 1:
                    delay = initial_delay * (2 ** attempt)  # 0.1s, 0.2s, 0.4s
                    logging.warning(f"File locked, retrying in {delay}s... (attempt {attempt + 1}/{max_retries}): {e}")
                    time.sleep(delay)
                else:
                    # a single-attempt caller tries again on its next tick.
                    log = logging.debug if max_retries == 1 else logging.error
                    log(f"Failed to write after {max_retries} attempts (file locked): {e}")
                    if os.path.exists(temp_path):
                        try:
                            os.remove(temp_path)
                        except Exception:
                            pass

            except Exception as e:
                # Not a lock — retrying won't help.
                if os.path.exists(temp_path):
                    try:
                        os.remove(temp_path)
                    except Exception:
                        pass
                logging.error(f"An error occurred while writing to the file: {e}")
                break

# Default config, optionally merged into an existing one.
def generate_config_file(existing_config=None):
    # Carry the firebase section across — losing it unregisters the agent.
    preserved_firebase = None
    if existing_config is None and os.path.exists(CONFIG_PATH):
        try:
            with open(CONFIG_PATH, 'r') as f:
                file_config = json.load(f)
                if 'firebase' in file_config:
                    preserved_firebase = file_config['firebase']
                    logging.debug("Preserving firebase section from existing config file")
        except Exception as e:
            logging.debug(f"Could not read existing config to preserve firebase: {e}")
            pass

    default_config = {
        "version": CONFIG_VERSION,
        "environment": "production",
        "processes": [],
        "logging": {
            "level": "INFO",
            "max_age_days": 90,
            "firebase_shipping": {
                "enabled": False,
                "ship_errors_only": True
            }
        },
        "sentry": {
            "enabled": False,
            "dsn": ""
        },
        "displays": {
            "enabled": True,
            "assigned": None,
            "remoteApplyEnabled": False
        },
        "temperature": {
            "enabled": True
        },
        "watchdog": {
            "enabled": True,
            "thresholds": {
                "failure_seconds": 360,
                "boot_grace_seconds": 180
            },
            "budget": {
                "max_per_window": 3,
                "window_seconds": 3600
            },
            "preconditions": {
                "require_internet": True,
                "fatal_error_suppression_seconds": 3600
            }
        }
    }

    if existing_config is None:
        if preserved_firebase:
            default_config['firebase'] = preserved_firebase
            logging.debug("Added preserved firebase section to generated config")
        return default_config

    # Update only missing keys
    for key, value in default_config.items():
        if key not in existing_config:
            existing_config[key] = value

    return existing_config

# Whole config, a key path within it, or one process entry by its ID.
def read_config(keys=None, process_list_id=None):
    config = _read_config_cached()

    if process_list_id:
        for process in config['processes']:
            if process['id'] == process_list_id:
                if keys:
                    item = process
                    for key in keys:
                        item = item.get(key, None)
                        if item is None:
                            return None
                    return item
                else:
                    return process

    elif keys:
        item = config
        for key in keys:
            item = item.get(key, None)
            if item is None:
                return None
        return item

    return config

def write_config(keys, value):
    """Set one nested key path in config.json, creating missing intermediates.

    `item.get(key, {})` used to walk into a detached dict whenever an
    intermediate was absent, so the write landed nowhere and was reported as a
    success — a silent no-op on any path the config had not grown yet.

    Raises ValueError when an intermediate exists but is not a dict: overwriting
    a scalar with a dict to make room would destroy whatever it held.
    """
    config = read_json_from_file(CONFIG_PATH)

    item = config
    for depth, key in enumerate(keys[:-1]):
        child = item.get(key)
        if child is None:
            child = {}
            item[key] = child
        elif not isinstance(child, dict):
            raise ValueError(
                f"Cannot write config path {'.'.join(map(str, keys))}: "
                f"{'.'.join(map(str, keys[:depth + 1]))} holds "
                f"{type(child).__name__}, not an object"
            )
        item = child

    item[keys[-1]] = value

    write_json_to_file(config, CONFIG_PATH)
    # Publish to the cache so in-process reads see it without waiting on mtime.
    _invalidate_config_cache(config)

# PROCESS TERMINATION

def find_windows_by_pid(pid):
    """Find all top-level window handles (HWNDs) owned by a given PID."""
    import win32gui
    import win32process
    windows = []
    def enum_callback(hwnd, _):
        try:
            _, window_pid = win32process.GetWindowThreadProcessId(hwnd)
            if window_pid == pid and win32gui.IsWindowVisible(hwnd):
                windows.append(hwnd)
        except Exception:
            pass
    try:
        win32gui.EnumWindows(enum_callback, None)
    except Exception:
        pass
    return windows


def _reap_orphaned_descendants(snapshot, pid):
    """Kill descendants that outlived the process they belonged to.

    `snapshot` must predate the parent's exit — afterwards the parent/child link
    is gone and survivors are unattributable. Only called once the parent is
    confirmed dead. Matches (pid, create_time), not pid alone: Windows recycles
    pids fast and a bare match could kill an unrelated process.
    """
    reaped = []
    for child_pid, created in snapshot:
        try:
            child = psutil.Process(child_pid)
            if child.create_time() != created:
                continue  # pid was recycled — not our child
            name = child.name()
            child.terminate()
            try:
                child.wait(timeout=3)
            except psutil.TimeoutExpired:
                child.kill()
            reaped.append(f'{name} ({child_pid})')
        except (psutil.NoSuchProcess, psutil.AccessDenied):
            continue
    if reaped:
        logging.info(
            f"Reaped {len(reaped)} orphaned child process(es) of {pid}: "
            f"{', '.join(reaped)}")
    return reaped


def graceful_terminate(pid, timeout=5, exe_path=None):
    """WM_CLOSE, then hard terminate. True if killed, False if already gone.

    `exe_path` only decides whether to reap children. A .bat/.cmd target runs
    behind a cmd.exe wrapper (process_launcher.build_hidden_batch_command), so
    the tracked pid is the wrapper: killing it leaves the real process alive and
    untracked, still holding its port/GPU/files while the supervisor reports a
    clean restart. Children are snapshotted before the kill, reaped after.

    Do not make this unconditional — for a plain .exe the children are the app's
    own business (TouchDesigner tears down TouchEngine.exe during WM_CLOSE) and
    reaping would race that cleanup.
    """
    import win32gui
    import win32con

    try:
        proc = psutil.Process(pid)
    except psutil.NoSuchProcess:
        return False

    # Snapshot while the parent lives — afterwards orphans are unattributable.
    wrapper_target = bool(exe_path) and exe_path.replace('/', '\\').lower().endswith(('.bat', '.cmd'))
    child_snapshot = []
    if wrapper_target:
        try:
            child_snapshot = [
                (c.pid, c.create_time()) for c in proc.children(recursive=True)
            ]
        except (psutil.NoSuchProcess, psutil.AccessDenied) as e:
            logging.debug(f"Could not enumerate children of {pid}: {e}")

    def _finish(result):
        # Reap even on result=False: the wrapper exiting on its own between the
        # snapshot and the kill orphans its children just the same.
        if wrapper_target:
            _reap_orphaned_descendants(child_snapshot, pid)
        return result

    # Graceful: WM_CLOSE every visible window.
    windows = find_windows_by_pid(pid)
    if windows:
        for hwnd in windows:
            try:
                win32gui.PostMessage(hwnd, win32con.WM_CLOSE, 0, 0)
            except Exception:
                pass

        try:
            proc.wait(timeout=timeout)
            logging.info(f"Process {pid} exited gracefully after WM_CLOSE")
            return _finish(True)
        except psutil.TimeoutExpired:
            logging.info(f"Process {pid} did not exit after WM_CLOSE ({timeout}s), forcing terminate")

    # Fall back to hard terminate
    try:
        proc.terminate()
        proc.wait(timeout=3)
        return _finish(True)
    except psutil.NoSuchProcess:
        return _finish(False)
    except psutil.TimeoutExpired:
        try:
            proc.kill()
            return _finish(True)
        except psutil.NoSuchProcess:
            return _finish(False)


# PROCESSES

def read_process_identity(pid):
    """Snapshot a live process's identity: {pid, create_time, exe}.

    The record half of the managed-or-inherited rule: owlette operations touch
    only processes owlette launched or deliberately inherited, and both cases
    are later proven by comparing this snapshot against the live process
    (identity_matches). The exe is normalised the way the matching code in
    find_running_process_by_exe normalises paths (forward slashes to back,
    lowercase) so stored records compare cheaply, without re-normalising on
    every check.

    Returns None on ANY failure (dead pid, access denied, zombie) -- a caller
    that cannot read an identity must treat the process as unmanaged.
    """
    try:
        proc = psutil.Process(int(pid))
        # oneshot caches the underlying process handle/queries so create_time
        # and exe come from one consistent view of the process.
        with proc.oneshot():
            create_time = proc.create_time()
            exe = proc.exe() or ''
        return {
            'pid': int(pid),
            'create_time': create_time,
            'exe': exe.replace('/', '\\').lower(),
        }
    except Exception as e:
        logging.debug(f"read_process_identity({pid}) failed: {e}")
        return None


def identity_matches(record, pid):
    """True iff the live process at `pid` is the one `record` describes.

    Every destructive operation under the managed-or-inherited rule must prove
    the pid it is about to touch still belongs to the process owlette recorded;
    anything else is a refusal. create_time is compared EXACTLY, never with a
    tolerance: psutil returns the kernel-stamped creation time verbatim, two
    reads of the same process yield the identical float, and the JSON round
    trip through app_states.json preserves it bit-for-bit (repr-based float
    serialisation round-trips). Any difference therefore means the pid was
    recycled -- the same idiom _reap_orphaned_descendants relies on to avoid
    killing a stranger behind a reused pid. A tolerance window would reopen
    exactly that hole.

    exe is a sanity check only: with equal (pid, create_time) a differing exe
    means the record itself is corrupt, which earns a warning -- and is still
    a refusal. Missing/None/malformed record -> False. Never raises.
    """
    if not isinstance(record, dict):
        return False
    try:
        recorded_pid = int(record['pid'])
        recorded_create_time = record['create_time']
    except (KeyError, TypeError, ValueError):
        return False
    try:
        if int(pid) != recorded_pid:
            return False
    except (TypeError, ValueError):
        return False
    live = read_process_identity(pid)
    if live is None:
        return False
    if live['create_time'] != recorded_create_time:
        return False  # pid recycled -- a different process wears this pid now
    recorded_exe = record.get('exe')
    if recorded_exe:
        # Records written by read_process_identity are already normalised;
        # normalise again anyway so hand-written or legacy records compare
        # fairly instead of failing on slash direction or case.
        recorded_exe_normalised = str(recorded_exe).replace('/', '\\').lower()
        if recorded_exe_normalised != live['exe']:
            logging.warning(
                f"identity_matches: pid {recorded_pid} create_time matches but "
                f"exe does not (recorded {recorded_exe_normalised!r}, live "
                f"{live['exe']!r}) -- corrupt record, refusing")
            return False
    return True


def update_process_status_in_json(pid, new_status, firebase_client=None, process_id=None, extra=None):
    """Write a process status to app_states.json; the metrics loop syncs it to
    Firebase. firebase_client is deprecated, kept for signature compatibility.

    `extra`, when a dict, is merged into the pid's row alongside status/id --
    row-level only, because the desktop parser prunes non-numeric top-level
    keys and would persist the pruned document. Per-row extras are established
    precedent (owlette_scout writes responsive/responsive_prev/hung_since the
    same way); this is how identity records reach app_states.json.
    """
    # A None pid would be written as the literal key "None" and corrupt the file.
    if pid is None:
        logging.debug(f"Skipping status update for None PID (status={new_status}, process_id={process_id})")
        return

    data = read_json_from_file(RESULT_FILE_PATH)

    if data is None:
        data = {}

    if str(pid) not in data:
        data[str(pid)] = {}

    data[str(pid)]['status'] = new_status
    if process_id:
        data[str(pid)]['id'] = process_id
    if isinstance(extra, dict):
        data[str(pid)].update(extra)
    write_json_to_file(data, RESULT_FILE_PATH)

def find_running_process_by_exe(exe_path, file_path=None, strict=False,
                                expected_cmdline=None):
    """Find a running process by its executable path -- unambiguously, or not
    at all.

    Matches on exe basename so a file-association launch of a different build
    still resolves as a candidate. .bat/.cmd targets run behind cmd.exe, so a
    script exe_path matches a cmd.exe whose command line references it.

    Only unambiguous evidence returns a pid:
      1. file_path found in a candidate's command line -- unambiguous even
         with several instances of the exe (TouchDesigner: one process per
         .toe).
      2. an exact exe-path match that is unique on the machine (for scripts:
         a unique cmd.exe wrapper referencing the script).
      3. expected_cmdline -- a launch command line the caller RECORDED
         (space-joined argv) -- equal, after path normalisation, to exactly
         one candidate's live cmdline. This is the only cmdline tier: with no
         file_path there is nothing CONFIGURED to compare a live cmdline
         against, so bare cmdlines are never ranked or guessed from; only
         recorded launch evidence counts. It is consulted only after tiers
         1-2 fail, i.e. it disambiguates, it never vetoes.

    Everything else returns None in BOTH modes: several instances with
    nothing to tell them apart, several cmd.exe wrappers for one script, or
    (non-strict) processes sharing only the image name. For the non-strict
    adoption callers None deliberately means "launch fresh" (D3): a duplicate
    instance is recoverable and converges once identity is recorded, while
    adopting -- and later killing -- a stranger is not.

    strict=True additionally refuses bare image-name candidates outright.
    Anything that kills or restarts MUST pass strict=True.
    """
    try:
        exe_lower = exe_path.replace('/', '\\').lower()
        exe_basename = os.path.basename(exe_lower)
        file_path_lower = file_path.replace('/', '\\').lower() if file_path else None
        # Same normalisation as the live cmdlines below, so recorded evidence
        # compares exactly regardless of slash direction or case.
        expected_lower = (expected_cmdline.replace('/', '\\').lower()
                          if expected_cmdline else None)
        is_script = exe_lower.endswith(('.bat', '.cmd'))
        candidates = []      # (pid, full_match, cmdline-or-None) -- exe targets
        script_matches = []  # (pid, cmdline) -- cmd.exe wrappers for a script
        for proc in psutil.process_iter(['pid', 'exe']):
            try:
                if not proc.info['exe']:
                    continue
                proc_exe = proc.info['exe'].lower()
                if is_script:
                    # The wrapper is cmd.exe; identify it by its command line.
                    if os.path.basename(proc_exe) != 'cmd.exe':
                        continue
                    try:
                        cmdline = ' '.join(proc.cmdline()).replace('/', '\\').lower()
                    except (psutil.NoSuchProcess, psutil.AccessDenied):
                        continue
                    if exe_lower not in cmdline:
                        continue
                    if file_path_lower and file_path_lower not in cmdline:
                        continue
                    # Collect instead of returning first: several wrappers for
                    # one script are ambiguous and must refuse (D3).
                    script_matches.append((proc.info['pid'], cmdline))
                    continue
                full_match = proc_exe == exe_lower
                basename_match = os.path.basename(proc_exe) == exe_basename
                if not (full_match or basename_match):
                    continue
                # Strict: a bare basename match is never enough.
                if strict and not full_match and not file_path_lower:
                    continue
                if file_path_lower:
                    try:
                        cmdline = ' '.join(proc.cmdline()).replace('/', '\\').lower()
                        if file_path_lower not in cmdline:
                            continue  # wrong instance
                    except (psutil.NoSuchProcess, psutil.AccessDenied):
                        continue  # unverifiable cmdline -- don't risk a false match
                    return proc.info['pid']  # cmdline-corroborated
                cmdline = None
                if expected_lower:
                    # Reading a cmdline is a per-process syscall -- only pay
                    # for it when there is recorded evidence to compare with.
                    try:
                        cmdline = ' '.join(proc.cmdline()).replace('/', '\\').lower()
                    except (psutil.NoSuchProcess, psutil.AccessDenied):
                        cmdline = None  # unreadable -> can never corroborate
                candidates.append((proc.info['pid'], full_match, cmdline))
            except (psutil.NoSuchProcess, psutil.AccessDenied):
                continue
        if is_script:
            if len(script_matches) == 1:
                return script_matches[0][0]
            if expected_lower:
                exact = [pid for pid, cmdline in script_matches
                         if cmdline == expected_lower]
                if len(exact) == 1:
                    return exact[0]
            if script_matches:
                # Ambiguous wrappers refuse in BOTH modes: binding one at
                # random risks watching -- and later killing -- a cmd.exe
                # owlette never launched (D3).
                logging.warning(
                    f"find_running_process_by_exe: {len(script_matches)} "
                    f"cmd.exe wrappers reference {exe_path} and nothing "
                    f"distinguishes them -- refusing to guess"
                    + ("" if strict else "; the caller will launch fresh"))
            return None
        # An exact exe-path match that is unique on the machine is the only
        # self-sufficient evidence left; several instances of one image are
        # normal here (every TouchDesigner project is the same
        # TouchDesigner.exe), so uniqueness, not rank order, is what counts.
        full_matches = [pid for pid, is_full, _ in candidates if is_full]
        if len(full_matches) == 1:
            return full_matches[0]
        # Cmdline tier: exact equality with the RECORDED launch cmdline, and
        # exactly one winner. Zero exact matches is a mismatch, several is
        # still ambiguity -- both refuse, because a wrong guess here is
        # precisely the disease D3 cures.
        if expected_lower:
            exact = [pid for pid, _, cmdline in candidates
                     if cmdline == expected_lower]
            if len(exact) == 1:
                return exact[0]
        if candidates:
            # Ambiguous, so BOTH modes refuse: strict discovery backs kill and
            # restart and must never touch a stranger; non-strict adoption
            # falls through to a fresh launch, which is safe by design -- the
            # duplicate converges once identity is recorded, an adopted
            # stranger never does (D3). Operators grep these warnings.
            if full_matches:
                what = (f"{len(full_matches)} instances of {exe_path} are "
                        f"running and no file_path is configured to tell "
                        f"them apart")
            else:
                what = (f"{len(candidates)} process(es) match {exe_basename} "
                        f"only by image name, not the configured path "
                        f"{exe_path}")
            logging.warning(
                "find_running_process_by_exe: " + what + " -- refusing to "
                "guess"
                + ("" if strict else "; the caller will launch fresh. Set the "
                   "file path on this process entry to make matching "
                   "unambiguous"))
        return None
    except Exception:
        # The silent pass that lived here hid real psutil/OS faults
        # (observability sweep finding). Log the traceback; still report
        # not-found so the monitor loop survives and callers take their
        # normal launch-fresh path.
        logging.exception(
            f"find_running_process_by_exe({exe_path!r}) failed unexpectedly "
            f"-- treating as not found")
    return None


def fetch_process_id_by_name(name, data):
    process = next((process for process in data['processes'] if process['name'] == name), None)
    return process['id'] if process else None

# METRICS
def get_system_info():
    cpu_info = get_cpu_name()
    if not cpu_info:
        cpu_info = platform.processor()
    cpu_usage = psutil.cpu_percent()
    memory_info = psutil.virtual_memory()
    disk_info = psutil.disk_usage('/')
    _g = _get_gputil()
    gpus = _g.getGPUs() if _g else []
    gpu_info = gpus[0] if gpus else "No GPU detected"

    bytes_to_gb = lambda x: round(x / (1024 ** 3), 2)

    return {
        'cpu_model': cpu_info,
        'cpu_usage': cpu_usage,
        'memory_used': bytes_to_gb(memory_info.used),
        'memory_total': bytes_to_gb(memory_info.total),
        'disk_used': bytes_to_gb(disk_info.used),
        'disk_total': bytes_to_gb(disk_info.total),
        'gpu_model': gpu_info.name if gpu_info else 'N/A',
        'gpu_info': gpu_info.memoryUsed if gpu_info else 'N/A',
        'gpu_total': gpu_info.memoryTotal if gpu_info else 'N/A'
    }

def get_system_metrics(skip_gpu=False):
    """System metrics for Firebase: CPU model/%, memory and disk in GB, GPU
    usage % and VRAM GB, plus per-process config + runtime state.

    skip_gpu: skip GPU probes, which flash a console window when called from a UI.
    """
    # mtime-cached read; returns a deep copy, safe to pass down.
    config = read_config()
    return get_system_metrics_with_config(config, skip_gpu)


def get_system_metrics_with_config(config=None, skip_gpu=False):
    """Legacy snake_case metrics (cpu/memory/disk/gpu/network/processes) for
    in-process consumers: mcp_tools and configure_site's feedback report.
    firebase_client reads only `memory` and `processes` — the v2 heartbeat
    sources per-device metrics from hardware_profile.collect_dynamic_metrics()
    instead.

    config: reuse a dict to skip a disk read; None goes through the mtime cache.
    skip_gpu: skip the nvidia-smi / sensor probes that flash a console window.
    """
    if config is None:
        config = read_config()
    try:
        cpu_name = get_cpu_name()
        cpu_percent = round(psutil.cpu_percent(interval=0.1), 1)
        cpu_temp = get_cpu_temperature()

        # GB, emitted in both snake_case and camelCase for v1 + v2 readers.
        mem = psutil.virtual_memory()
        mem_used_gb = round(mem.used / (1024**3), 2)
        mem_total_gb = round(mem.total / (1024**3), 2)
        mem_percent = round(mem.percent, 1)

        # System drive only.
        try:
            disk = psutil.disk_usage('/')
            disk_used_gb = round(disk.used / (1024**3), 2)
            disk_total_gb = round(disk.total / (1024**3), 2)
            disk_percent = round(disk.percent, 1)
        except Exception:
            disk_used_gb = 0.0
            disk_total_gb = 0.0
            disk_percent = 0.0

        # First GPU only.
        gpu_usage_percent = 0
        gpu_vram_used_gb = 0
        gpu_vram_total_gb = 0
        gpu_name = "N/A"
        gpu_temp = None
        if not skip_gpu:
            try:
                _g = _get_gputil()
                gpus = _g.getGPUs() if _g else []
                if gpus:
                    g0 = gpus[0]
                    gpu_usage_percent = round(g0.load * 100, 1)
                    gpu_vram_used_gb = round(g0.memoryUsed / 1024, 2)
                    gpu_vram_total_gb = round(g0.memoryTotal / 1024, 2)
                    gpu_name = g0.name
                    gpu_temps = get_gpu_temperatures()
                    if gpu_temps:
                        gpu_temp = gpu_temps[0].get('temperature')
            except Exception:
                pass

        # Network (legacy shape — v1 consumers)
        try:
            network_metrics = get_network_metrics() or {}
        except Exception:
            network_metrics = {}
        try:
            quality = get_network_quality() or {}
        except Exception:
            quality = {}
        network_metrics.setdefault('interfaces', {})
        if 'latency_ms' in quality:
            network_metrics['latency_ms'] = quality.get('latency_ms')
        if 'packet_loss_pct' in quality:
            network_metrics['packet_loss_pct'] = quality.get('packet_loss_pct')
        if 'gateway_ip' in quality:
            network_metrics['gateway_ip'] = quality.get('gateway_ip')

        # Config + runtime state. Uses the passed-in config, not a fresh read —
        # re-reading here races the caller's snapshot.
        processes_data = {}
        try:
            runtime_state = read_json_from_file(RESULT_FILE_PATH)

            if config and 'processes' in config:
                pid_to_runtime = {}
                if runtime_state:
                    for pid, state_info in runtime_state.items():
                        # "None" keys come from failed launches.
                        try:
                            pid_int = int(pid)
                        except (ValueError, TypeError):
                            continue
                        process_id = state_info.get('id')
                        if process_id:
                            pid_to_runtime[process_id] = {
                                'pid': pid_int,
                                'status': state_info.get('status', 'UNKNOWN'),
                                'responsive': state_info.get('responsive', True),
                                'timestamp': state_info.get('timestamp', 0)
                            }

                for index, process in enumerate(config['processes']):
                    process_id = process.get('id')
                    if process_id:
                        process_data = {
                            'name': process.get('name', ''),
                            'exe_path': process.get('exe_path', ''),
                            'file_path': process.get('file_path', ''),
                            'cwd': process.get('cwd', ''),
                            'autolaunch': process.get('autolaunch', False),
                            'launch_mode': process.get('launch_mode', 'always' if process.get('autolaunch', False) else 'off'),
                            'schedules': process.get('schedules', None),
                            'priority': process.get('priority', 'Normal'),
                            'visibility': process.get('visibility', 'Show'),
                            'time_delay': process.get('time_delay', 0),
                            'time_to_init': process.get('time_to_init', 10),
                            'relaunch_attempts': process.get('relaunch_attempts', 5),
                            'index': index  # config order, for web display
                        }

                        if process_id in pid_to_runtime:
                            runtime = pid_to_runtime[process_id]
                            process_data['pid'] = runtime['pid']
                            process_data['status'] = runtime['status']
                            process_data['responsive'] = runtime['responsive']
                            process_data['last_updated'] = runtime['timestamp']
                        else:
                            process_data['pid'] = None
                            mode = process.get('launch_mode', 'always' if process.get('autolaunch', False) else 'off')
                            process_data['status'] = 'INACTIVE' if mode == 'off' else 'STOPPED'
                            process_data['responsive'] = True
                            process_data['last_updated'] = 0

                        processes_data[process_id] = process_data
        except Exception as e:
            logging.error(f"Error collecting process data: {e}")

        cpu_metrics = {
            'name': cpu_name,
            'percent': cpu_percent,
            'unit': '%',
        }
        if cpu_temp is not None:
            cpu_metrics['temperature'] = round(cpu_temp, 1)

        gpu_metrics = {
            'name': gpu_name,
            'usage_percent': gpu_usage_percent,
            'vram_used_gb': gpu_vram_used_gb,
            'vram_total_gb': gpu_vram_total_gb,
            'unit': '%',
        }
        if gpu_temp is not None:
            gpu_metrics['temperature'] = round(gpu_temp, 1)

        return {
            'cpu': cpu_metrics,
            'memory': {
                'percent': mem_percent,
                'used_gb': mem_used_gb,
                'total_gb': mem_total_gb,
                'usedGb': mem_used_gb,
                'unit': 'GB',
            },
            'disk': {
                'percent': disk_percent,
                'used_gb': disk_used_gb,
                'total_gb': disk_total_gb,
                'unit': 'GB',
            },
            'gpu': gpu_metrics,
            'network': network_metrics,
            'processes': processes_data,
        }
    except Exception as e:
        logging.error(f"Error getting system metrics: {e}")
        return {
            'cpu': {'name': 'Unknown', 'percent': 0.0, 'unit': '%'},
            'memory': {'percent': 0.0, 'used_gb': 0.0, 'total_gb': 0.0, 'usedGb': 0.0, 'unit': 'GB'},
            'disk': {'percent': 0.0, 'used_gb': 0.0, 'total_gb': 0.0, 'unit': 'GB'},
            'gpu': {'name': 'N/A', 'usage_percent': 0, 'vram_used_gb': 0, 'vram_total_gb': 0, 'unit': '%'},
            'network': {'interfaces': {}},
            'processes': {},
        }
