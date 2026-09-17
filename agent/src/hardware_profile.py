"""Hardware profile + dynamic metrics collection (schemaVersion 1)."""

import hashlib
import json
import logging
import socket
import sys
import time
from concurrent.futures import ThreadPoolExecutor, TimeoutError as FuturesTimeoutError
from typing import Optional

import psutil

import shared_utils

logger = logging.getLogger(__name__)

SCHEMA_VERSION = 1

_IS_WINDOWS = sys.platform == 'win32'

# GPU temperature cache (used only when multiple GPUs are present to avoid
# repeated sensor reads inside a single metrics tick).
_gpu_temp_cache: dict = {}
_gpu_temp_cache_time: float = 0.0
_GPU_TEMP_TTL = 5.0


def _agent_version() -> str:
    try:
        return shared_utils.get_app_version()
    except Exception:
        return '0.0.0'


def _collect_cpus() -> list:
    cpus = []
    # Socket topology is WMI's; off Windows the query can only fail, and its
    # fallback log is a warning on every profile rebuild.
    if _IS_WINDOWS:
        try:
            # WMI uses COM; background threads must register with the COM runtime
            # before making calls. Idempotent on threads that already initialized.
            try:
                import pythoncom
                pythoncom.CoInitialize()
            except Exception:
                pass
            import wmi
            c = wmi.WMI()
            for idx, proc in enumerate(c.Win32_Processor()):
                try:
                    physical = int(getattr(proc, 'NumberOfCores', 0) or 0)
                except (TypeError, ValueError):
                    physical = 0
                try:
                    logical = int(getattr(proc, 'NumberOfLogicalProcessors', 0) or 0)
                except (TypeError, ValueError):
                    logical = 0
                name = (getattr(proc, 'Name', '') or '').strip() or 'Unknown CPU'
                cpus.append({
                    'id': 'CPU{0}'.format(idx),
                    'model': name,
                    'physicalCores': physical,
                    'logicalCores': logical,
                    'socketIndex': idx,
                })
            if cpus:
                return cpus
        except Exception as e:
            logger.warning('WMI Win32_Processor query failed, falling back: %s', e)

    # Fallback: single-socket inference from psutil + registry.
    try:
        physical = int(psutil.cpu_count(logical=False) or 0)
    except Exception:
        physical = 0
    try:
        logical = int(psutil.cpu_count(logical=True) or 0)
    except Exception:
        logical = 0
    cpus.append({
        'id': 'CPU0',
        'model': shared_utils.get_cpu_name(),
        'physicalCores': physical,
        'logicalCores': logical,
        'socketIndex': 0,
    })
    return cpus


def _disk_usage_with_timeout(mount: str, timeout: float = 2.0):
    """Call psutil.disk_usage under a watchdog — hung network mounts must not block."""
    # Manual lifecycle so a hung disk_usage worker can't block our exit via
    # the default `with`-shutdown(wait=True). See _wmi_logical_disk_with_timeout
    # in shared_utils.py for the same fix; both watchdogs need it.
    pool = ThreadPoolExecutor(max_workers=1)
    try:
        future = pool.submit(psutil.disk_usage, mount)
        try:
            return future.result(timeout=timeout)
        except FuturesTimeoutError:
            logger.warning('disk_usage(%s) timed out — skipping partition', mount)
            return None
        except Exception as e:
            logger.warning('disk_usage(%s) failed: %s', mount, e)
            return None
    finally:
        pool.shutdown(wait=False, cancel_futures=True)


def _collect_disks() -> list:
    disks = []
    try:
        partitions = psutil.disk_partitions(all=False)
    except Exception as e:
        logger.warning('disk_partitions failed: %s', e)
        return disks

    for part in partitions:
        opts = (part.opts or '').lower()
        if 'cdrom' in opts or 'removable' in opts:
            continue
        if not part.fstype:
            continue
        usage = _disk_usage_with_timeout(part.mountpoint)
        if usage is None:
            continue
        mount_id = part.mountpoint.rstrip('\\/') or part.mountpoint
        disks.append({
            'id': mount_id,
            'label': part.device or mount_id,
            'fs': part.fstype,
            'totalGb': round(usage.total / (1024 ** 3), 1),
        })
    return disks


def _collect_gpus() -> list:
    gpus = []
    for idx, gpu in enumerate(shared_utils.get_gpus()):
        name = getattr(gpu, 'name', '') or 'Unknown GPU'
        uuid = getattr(gpu, 'uuid', None)
        if uuid:
            gpu_id = uuid
        else:
            digest = hashlib.sha256('{0}|{1}'.format(name, idx).encode('utf-8')).hexdigest()[:8]
            gpu_id = 'GPU-{0}'.format(digest)
        try:
            vram_total_gb = round(float(gpu.memoryTotal) / 1024.0, 2)
        except (TypeError, ValueError, AttributeError):
            vram_total_gb = 0.0
        gpus.append({
            'id': gpu_id,
            'name': name,
            'vramTotalGb': vram_total_gb,
            'pciBus': None,
        })
    return gpus


def _mac_for(iface: str, addrs: dict) -> Optional[str]:
    entries = addrs.get(iface) or []
    af_link = getattr(psutil, 'AF_LINK', None)
    for a in entries:
        if af_link is not None and a.family == af_link and a.address:
            return a.address
    return None


def _collect_nics() -> list:
    nics = []
    try:
        stats = psutil.net_if_stats()
        addrs = psutil.net_if_addrs()
    except Exception as e:
        logger.warning('net_if_stats/addrs failed: %s', e)
        return nics

    for name, s in stats.items():
        if not s.isup:
            continue
        lname = name.lower()
        if 'loopback' in lname or lname.startswith('lo'):
            continue
        has_ip = any(
            a.family in (socket.AF_INET, socket.AF_INET6) and a.address
            for a in addrs.get(name, [])
        )
        if not has_ip:
            continue
        nics.append({
            'id': name,
            'mac': _mac_for(name, addrs),
            'linkSpeedMbps': int(s.speed) if s.speed and s.speed > 0 else 0,
        })
    return nics


def build_profile() -> dict:
    profile = {
        'schemaVersion': SCHEMA_VERSION,
        'signatureHash': '',
        'capturedAt': int(time.time()),
        'agentVersion': _agent_version(),
        'cpus': _collect_cpus(),
        'disks': _collect_disks(),
        'gpus': _collect_gpus(),
        'nics': _collect_nics(),
    }
    profile['signatureHash'] = profile_signature(profile)
    return profile


def profile_signature(profile: dict) -> str:
    """Deterministic sha256 over stable device fields only."""
    stable = {
        'schemaVersion': profile.get('schemaVersion'),
        'cpus': profile.get('cpus', []),
        'disks': profile.get('disks', []),
        'gpus': profile.get('gpus', []),
        'nics': profile.get('nics', []),
    }
    payload = json.dumps(stable, sort_keys=True, separators=(',', ':'))
    return hashlib.sha256(payload.encode('utf-8')).hexdigest()


def _gpu_temps_cached(multi_gpu: bool) -> list:
    global _gpu_temp_cache_time, _gpu_temp_cache
    now = time.monotonic()
    if multi_gpu and _gpu_temp_cache and (now - _gpu_temp_cache_time) < _GPU_TEMP_TTL:
        return _gpu_temp_cache.get('temps', [])
    temps = shared_utils.get_gpu_temperatures()
    if multi_gpu:
        _gpu_temp_cache = {'temps': temps}
        _gpu_temp_cache_time = now
    return temps


def collect_dynamic_metrics(profile: dict) -> dict:
    cpus_out = {}
    cpu_entries = profile.get('cpus', []) or []
    try:
        percpu = psutil.cpu_percent(interval=0.1, percpu=True) or []
    except Exception as e:
        logger.warning('cpu_percent failed: %s', e)
        percpu = []

    cpu_temp = shared_utils.get_cpu_temperature()
    cursor = 0
    for entry in cpu_entries:
        logical = int(entry.get('logicalCores') or 0)
        if logical <= 0:
            slice_vals = []
        else:
            slice_vals = percpu[cursor:cursor + logical]
            cursor += logical
        if slice_vals:
            avg = round(sum(slice_vals) / len(slice_vals), 1)
        else:
            avg = 0.0
        cpus_out[entry['id']] = {
            'percent': avg,
            'temperature': cpu_temp,
        }

    # Memory
    try:
        vm = psutil.virtual_memory()
        memory_out = {
            'percent': float(vm.percent),
            'usedGb': round(vm.used / (1024 ** 3), 2),
        }
    except Exception as e:
        logger.warning('virtual_memory failed: %s', e)
        memory_out = {'percent': 0.0, 'usedGb': 0.0}

    # Disks — iterate the profile so IDs stay aligned.
    disks_out = {}
    for entry in profile.get('disks', []) or []:
        disk_id = entry.get('id')
        if not disk_id:
            continue
        # A POSIX id is the mount point itself ('/', '/home'); a drive letter
        # is stored without its separator and psutil needs it back. Appending
        # one to a POSIX path drops that volume out of the payload, which is
        # every volume on the machine but the root filesystem.
        mount = (
            disk_id if disk_id.startswith('/') or disk_id.endswith(('\\', '/'))
            else disk_id + '\\'
        )
        usage = _disk_usage_with_timeout(mount)
        if usage is None:
            continue
        disks_out[disk_id] = {
            'percent': float(usage.percent),
            'usedGb': round(usage.used / (1024 ** 3), 2),
        }

    # GPUs
    gpus_out = {}
    profile_gpus = profile.get('gpus', []) or []
    multi_gpu = len(profile_gpus) > 1
    # Joined on the profile's GPU id (the NVML uuid _collect_gpus stored): a
    # device NVML cannot read is missing from the live list, which would shift a
    # positional join onto the wrong GPU.
    live_by_id = {g.uuid: g for g in shared_utils.get_gpus() if g.uuid}

    temps = _gpu_temps_cached(multi_gpu)
    temp_by_index = {t['index']: t['temperature'] for t in temps if isinstance(t, dict) and 'index' in t}

    for idx, entry in enumerate(profile_gpus):
        gpu_id = entry.get('id')
        if not gpu_id:
            continue
        usage_pct = 0.0
        vram_used_gb = 0.0
        g = live_by_id.get(gpu_id)
        if g is not None:
            try:
                usage_pct = round(float(g.load) * 100.0, 1)
            except (TypeError, ValueError, AttributeError):
                usage_pct = 0.0
            try:
                vram_used_gb = round(float(g.memoryUsed) / 1024.0, 2)
            except (TypeError, ValueError, AttributeError):
                vram_used_gb = 0.0
        gpus_out[gpu_id] = {
            'usagePercent': usage_pct,
            'vramUsedGb': vram_used_gb,
            'temperature': temp_by_index.get(idx),
        }

    # NICs — reshape shared_utils.get_network_metrics() into the new schema.
    nics_out = {}
    try:
        net = shared_utils.get_network_metrics() or {}
    except Exception as e:
        logger.warning('get_network_metrics failed: %s', e)
        net = {}
    iface_map = (net.get('interfaces') or {}) if isinstance(net, dict) else {}
    for entry in profile.get('nics', []) or []:
        nic_id = entry.get('id')
        if not nic_id:
            continue
        data = iface_map.get(nic_id, {})
        nics_out[nic_id] = {
            'txBps': float(data.get('tx_bps', 0) or 0),
            'rxBps': float(data.get('rx_bps', 0) or 0),
            'txUtil': float(data.get('tx_util', 0.0) or 0.0),
            'rxUtil': float(data.get('rx_util', 0.0) or 0.0),
        }

    # Network quality
    network_out = {'latencyMs': None, 'packetLossPct': None, 'gatewayIp': None}
    try:
        q = shared_utils.get_network_quality() or {}
        network_out['latencyMs'] = q.get('latency_ms')
        network_out['packetLossPct'] = q.get('packet_loss_pct')
        network_out['gatewayIp'] = q.get('gateway_ip')
    except Exception as e:
        logger.warning('get_network_quality failed: %s', e)

    # Per-volume disk IO (WMI LogicalDisk counters)
    try:
        diskio_out = shared_utils.get_disk_io_metrics() or {}
    except Exception as e:
        logger.warning('get_disk_io_metrics failed: %s', e)
        diskio_out = {}

    return {
        'cpus': cpus_out,
        'memory': memory_out,
        'disks': disks_out,
        'gpus': gpus_out,
        'nics': nics_out,
        'network': network_out,
        'diskio': diskio_out,
    }


def _pick_leader(items, score_fn):
    leader_id = None
    leader_score = None
    for dev_id, data in items:
        score = score_fn(data)
        if score is None:
            continue
        if leader_score is None or score > leader_score:
            leader_id = dev_id
            leader_score = score
    return leader_id, leader_score


def _apply_hysteresis(current_id, current_score, previous_id, items, score_fn, threshold=5.0):
    if previous_id is None or previous_id == current_id:
        return current_id
    if previous_id not in dict(items):
        return current_id
    prev_score = score_fn(dict(items)[previous_id])
    if prev_score is None or current_score is None:
        return current_id
    if (current_score - prev_score) < threshold:
        return previous_id
    return current_id


def compute_primary(metrics: dict, last_primary) -> dict:
    last = last_primary or {}

    def _score_percent(d):
        v = d.get('percent')
        return float(v) if v is not None else None

    def _score_usage(d):
        v = d.get('usagePercent')
        return float(v) if v is not None else None

    def _score_throughput(d):
        tx = d.get('txBps', 0) or 0
        rx = d.get('rxBps', 0) or 0
        return float(tx) + float(rx)

    result = {'cpu': None, 'disk': None, 'gpu': None, 'nic': None}

    cpu_items = list((metrics.get('cpus') or {}).items())
    if cpu_items:
        cid, cscore = _pick_leader(cpu_items, _score_percent)
        result['cpu'] = _apply_hysteresis(cid, cscore, last.get('cpu'), cpu_items, _score_percent)

    disk_items = list((metrics.get('disks') or {}).items())
    if disk_items:
        did, dscore = _pick_leader(disk_items, _score_percent)
        result['disk'] = _apply_hysteresis(did, dscore, last.get('disk'), disk_items, _score_percent)

    gpu_items = list((metrics.get('gpus') or {}).items())
    if gpu_items:
        gid, gscore = _pick_leader(gpu_items, _score_usage)
        result['gpu'] = _apply_hysteresis(gid, gscore, last.get('gpu'), gpu_items, _score_usage)

    nic_items = list((metrics.get('nics') or {}).items())
    if nic_items:
        nid, nscore = _pick_leader(nic_items, _score_throughput)
        result['nic'] = _apply_hysteresis(nid, nscore, last.get('nic'), nic_items, _score_throughput)

    return result
