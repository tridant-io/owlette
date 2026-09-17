"""
On-demand fetch of the Claude Code CLI binary that Cortex drives.

``claude-agent-sdk`` vendors it at ``_bundled/claude.exe`` (``_bundled/claude``
off Windows) — 241.5 MB, ~60% of the pre-3.0.0 installer.
``build_installer_full.bat`` strips it, so this module is the only path that
puts one back, and only once Cortex is enabled.

Pinned by sha256, one document per platform:
``installer_metadata/cortex_cli_<osFamily>_<arch>``, macOS universal2 under
``cortex_cli_macos_universal``. Each carries ``version``, ``downloadUrl``
(signed), ``sha256`` and an optional ``size`` (disk-space guard). That
collection is world-readable and service-account-write-only, so the agent reads
it with its normal token and only a trusted server can move the pin. Provision
with ``scripts/upload-cortex-cli.mjs``, which also keeps the unsuffixed
``installer_metadata/cortex_cli`` — the only id a pre-3.4 agent reads — pointing
at the Windows x64 payload.

``ensure_cli`` resolution order:
1. Sidecar-verified binary (``cache/claude-cli/version.json``) — no hashing, no
   network, provided size and pin still match.
2. Adopt a matching on-disk binary: hashing 241.5 MB beats downloading it. Covers
   a lost sidecar and the SDK copy left behind by an in-place 2.x upgrade. A
   cached binary that FAILS the pin is deleted — it can never satisfy it.
3. Pinned download to ``.part``, verify, ``os.replace`` into place, write the
   sidecar. A checksum rejection deletes and retries once.
4. Unverified fallback: any CLI on disk, with a warning. Deliberate fleet
   resilience — an outage must not take Cortex offline on a working machine.
5. Return None. Failures persist in ``fetch_state.json`` behind exponential
   backoff (5 min → 1 h), or the service's 30 s relaunch cooldown would turn a
   broken fetch into a 30 s download loop.

Offline: a sidecar-verified binary is used regardless of the pin, so a machine
that already fetched its CLI keeps working with no network.
"""

import json
import logging
import os
import shutil
import time
from collections import namedtuple
from typing import Any, Dict, Optional
from urllib.parse import urlparse

import shared_utils

logger = logging.getLogger(__name__)


CACHE_SUBDIR = os.path.join('cache', 'claude-cli')
PARTIAL_SUFFIX = '.part'
SIDECAR_FILENAME = 'version.json'
FETCH_STATE_FILENAME = 'fetch_state.json'

METADATA_DOC_PREFIX = 'installer_metadata/cortex_cli'

_PlatformCli = namedtuple('_PlatformCli', 'filename arch_slot executable')

# What the CLI looks like per OS family. Windows ships ``claude.exe`` and has no
# mode bit; every other family ships ``claude`` and needs 0750 after the
# download. ``arch_slot`` pins the id of a family whose build is not
# arch-specific: macOS is one universal2 binary and Windows is one x64 build that
# Windows-on-ARM runs emulated (plan decision 12), so neither keys its document
# id on the machine's arch.
_PLATFORM_CLI = {
    'windows': _PlatformCli('claude.exe', 'x64', False),
    'macos': _PlatformCli('claude', 'universal', True),
    'linux': _PlatformCli('claude', None, True),
}

# A family we have never published a CLI for: POSIX shape, arch-keyed id. The
# pin document then does not exist, which is exactly what ensure_cli reports.
_UNPUBLISHED_PLATFORM_CLI = _PlatformCli('claude', None, True)

# Complete-but-corrupt bytes are worth one more try; transport flakiness is
# already retried 3x inside download_file().
MAX_DOWNLOAD_ATTEMPTS = 2

# Persisted so the service's 30 s relaunch cooldown can't become a download loop.
FETCH_BACKOFF_BASE_SECONDS = 300      # 5 minutes after the first failure
FETCH_BACKOFF_MAX_SECONDS = 3600      # capped at 1 hour
MAX_TRACKED_FAILURES = 16             # keeps the shift below bounded

# Refuse to start a download that would leave the volume with no headroom.
FREE_SPACE_HEADROOM = 1.25

_SHA256_LENGTH = 64


def _platform_cli():
    """``(pin id suffix, spec)`` for the platform this agent runs on."""
    family, arch = shared_utils.get_os_family_arch()
    spec = _PLATFORM_CLI.get(family, _UNPUBLISHED_PLATFORM_CLI)
    return f"{family}_{spec.arch_slot or arch}", spec


def get_cli_filename() -> str:
    """The CLI's filename here: ``claude.exe`` on Windows, ``claude`` elsewhere."""
    return _platform_cli()[1].filename


def get_partial_filename() -> str:
    """The in-progress download's filename."""
    return get_cli_filename() + PARTIAL_SUFFIX


def get_metadata_doc_path() -> str:
    """This platform's pin, e.g. ``installer_metadata/cortex_cli_macos_universal``."""
    return f"{METADATA_DOC_PREFIX}_{_platform_cli()[0]}"


def _apply_executable_mode(path: str) -> None:
    """Give a freshly installed CLI the exec bit POSIX needs to run it. A no-op
    on Windows, which has no mode bit to set."""
    if _platform_cli()[1].executable:
        # Group-executable, not world: the cache directory belongs to the
        # daemon's group (the data-root mode table), and that group is how
        # the kiosk user's hoot process runs the binary.
        os.chmod(path, 0o750)


def _ensure_executable(path: str) -> str:
    """The same exec bit for a binary we did not install ourselves, best effort:
    an adopted or fallback CLI can sit in a read-only site-packages, and it is
    usually already runnable."""
    try:
        _apply_executable_mode(path)
    except OSError as e:
        logger.warning(f"Could not make the Claude CLI at {path} executable: {e}")
    return path


def get_cache_dir() -> str:
    """Absolute path of the CLI cache directory (``<data root>/cache/claude-cli``)."""
    return shared_utils.get_data_path(CACHE_SUBDIR)


def _sidecar_path() -> str:
    return os.path.join(get_cache_dir(), SIDECAR_FILENAME)


def _fetch_state_path() -> str:
    return os.path.join(get_cache_dir(), FETCH_STATE_FILENAME)


def get_bundled_cli_path() -> Optional[str]:
    """The SDK-vendored CLI path, if this install still has one.

    Mirrors ``SubprocessCLITransport._find_bundled_cli``. None when the SDK is
    absent or the installer build stripped the binary.
    """
    try:
        import claude_agent_sdk
    except Exception as e:  # ImportError, or a broken install
        logger.debug(f"claude_agent_sdk not importable: {e}")
        return None

    package_file = getattr(claude_agent_sdk, '__file__', None)
    if not package_file:
        return None

    candidate = os.path.join(os.path.dirname(package_file), '_bundled', get_cli_filename())
    return candidate if os.path.isfile(candidate) else None


def _read_json(path: str) -> Optional[Dict[str, Any]]:
    """Read a small JSON file, returning None when absent or unreadable."""
    try:
        with open(path, 'r', encoding='utf-8') as f:
            data = json.load(f)
        return data if isinstance(data, dict) else None
    except FileNotFoundError:
        return None
    except (OSError, ValueError) as e:
        logger.warning(f"Ignoring unreadable state file {path}: {e}")
        return None


def _write_json(path: str, data: Dict[str, Any]) -> bool:
    """Write a small JSON file atomically. Returns True on success."""
    tmp_path = path + '.tmp'
    try:
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with open(tmp_path, 'w', encoding='utf-8') as f:
            json.dump(data, f, indent=2)
        os.replace(tmp_path, path)
        return True
    except OSError as e:
        logger.warning(f"Failed to write {path}: {e}")
        try:
            os.remove(tmp_path)
        except OSError:
            pass
        return False


def _redact_url(url: str) -> str:
    """Strip the query string (signature) so logs never carry the signed token."""
    try:
        parsed = urlparse(url)
        if not parsed.scheme or not parsed.netloc:
            return '<url>'
        return f"{parsed.scheme}://{parsed.netloc}{parsed.path}"
    except ValueError:
        return '<url>'


def read_pinned_metadata(db) -> Optional[Dict[str, Any]]:
    """Read and validate this platform's ``installer_metadata/cortex_cli_*``.

    Returns a dict with ``version``, ``downloadUrl``, ``sha256`` and optional int
    ``size``, or None when the doc is missing, malformed, or unreadable.
    """
    if db is None:
        logger.warning("No Firestore client available — cannot read the pinned CLI metadata")
        return None

    doc_path = get_metadata_doc_path()

    try:
        doc = db.get_document(doc_path)
    except Exception as e:
        logger.warning(f"Failed to read {doc_path}: {e}")
        return None

    if not doc:
        logger.error(
            f"{doc_path} is missing — provision it with "
            "scripts/upload-cortex-cli.mjs before enabling Cortex"
        )
        return None

    version = doc.get('version')
    download_url = doc.get('downloadUrl')
    sha256 = doc.get('sha256')

    if not isinstance(version, str) or not version.strip():
        logger.error(f"{doc_path}: 'version' is missing or not a string")
        return None
    if not isinstance(download_url, str) or not download_url.lower().startswith('https://'):
        logger.error(f"{doc_path}: 'downloadUrl' is missing or not an https url")
        return None
    if not isinstance(sha256, str) or len(sha256) != _SHA256_LENGTH:
        logger.error(f"{doc_path}: 'sha256' is missing or not a 64-char digest")
        return None
    try:
        int(sha256, 16)
    except ValueError:
        logger.error(f"{doc_path}: 'sha256' is not hexadecimal")
        return None

    size = doc.get('size')
    size = int(size) if isinstance(size, (int, float)) and size > 0 else None

    return {
        'version': version.strip(),
        'downloadUrl': download_url,
        'sha256': sha256.lower(),
        'size': size,
    }


def _sidecar_binary(sidecar: Optional[Dict[str, Any]],
                    pinned: Optional[Dict[str, Any]]) -> Optional[str]:
    """The recorded binary's path while it is still trustworthy: exists, still
    the recorded size, and — when ``pinned`` is given — verified against the
    current pin. ``pinned=None`` relaxes only the pin, never existence/size.
    """
    if not sidecar:
        return None

    path = sidecar.get('path')
    recorded_size = sidecar.get('size')
    recorded_sha = sidecar.get('sha256')
    recorded_version = sidecar.get('version')

    if not isinstance(path, str) or not path or not isinstance(recorded_size, int):
        logger.warning("CLI sidecar is malformed — re-verifying from scratch")
        return None

    if not os.path.isfile(path):
        logger.info(f"Cached CLI is gone ({path}) — will re-fetch")
        return None

    try:
        actual_size = os.path.getsize(path)
    except OSError as e:
        logger.warning(f"Cannot stat cached CLI {path}: {e}")
        return None

    if actual_size != recorded_size:
        logger.warning(
            f"Cached CLI size changed ({actual_size} != {recorded_size}) — discarding the cache"
        )
        return None

    if pinned is not None:
        if recorded_sha != pinned['sha256'] or recorded_version != pinned['version']:
            logger.info(
                f"Cached CLI is version {recorded_version}, pin is {pinned['version']} — re-fetching"
            )
            return None

    return path


def _write_sidecar(path: str, version: str, sha256: str, source: str) -> None:
    """Record a checksum-verified binary so later starts skip the hash."""
    try:
        size = os.path.getsize(path)
    except OSError as e:
        logger.warning(f"Cannot stat verified CLI {path}: {e}")
        return

    _write_json(_sidecar_path(), {
        'version': version,
        'sha256': sha256,
        'size': size,
        'path': path,
        'source': source,
        'fetchedAt': int(time.time()),
    })


def _fetch_backoff_remaining() -> float:
    """Seconds left before another fetch attempt is allowed (0 when allowed)."""
    state = _read_json(_fetch_state_path())
    if not state:
        return 0.0

    try:
        failures = int(state.get('consecutiveFailures') or 0)
        last_failure = float(state.get('lastFailureAt') or 0)
    except (TypeError, ValueError):
        return 0.0

    if failures <= 0 or last_failure <= 0:
        return 0.0

    now = time.time()
    if last_failure > now:
        # Clock moved backwards, or hand-edited — don't wedge.
        return 0.0

    delay = min(
        FETCH_BACKOFF_BASE_SECONDS * (2 ** (min(failures, MAX_TRACKED_FAILURES) - 1)),
        FETCH_BACKOFF_MAX_SECONDS,
    )
    return max(0.0, (last_failure + delay) - now)


def _record_fetch_failure(reason: str) -> None:
    state = _read_json(_fetch_state_path()) or {}
    try:
        failures = int(state.get('consecutiveFailures') or 0)
    except (TypeError, ValueError):
        failures = 0

    _write_json(_fetch_state_path(), {
        'consecutiveFailures': min(failures + 1, MAX_TRACKED_FAILURES),
        'lastFailureAt': time.time(),
        'lastError': reason,
    })


def _clear_fetch_failures() -> None:
    try:
        os.remove(_fetch_state_path())
    except FileNotFoundError:
        pass
    except OSError as e:
        logger.debug(f"Could not clear CLI fetch state: {e}")


def _has_free_space(cache_dir: str, needed: Optional[int]) -> bool:
    """Guard against filling a kiosk's system volume with a 241.5 MB download."""
    if not needed:
        return True
    try:
        free = shutil.disk_usage(cache_dir).free
    except OSError as e:
        logger.debug(f"Could not check free space on {cache_dir}: {e}")
        return True

    required = int(needed * FREE_SPACE_HEADROOM)
    if free < required:
        logger.error(
            f"Not enough disk space for the Claude CLI: need ~{required // (1024 * 1024)} MB, "
            f"{free // (1024 * 1024)} MB free on {cache_dir}"
        )
        return False
    return True


def _make_progress_logger(total_label: str):
    """Log download progress once per 10% so cortex.log stays readable."""
    state = {'last': -1}

    def _on_progress(percent: int) -> None:
        bucket = (percent // 10) * 10
        if bucket > state['last']:
            state['last'] = bucket
            logger.info(f"Downloading Claude CLI ({total_label}): {bucket}%")

    return _on_progress


def _download_and_verify(pinned: Dict[str, Any], cache_dir: str) -> Optional[str]:
    """Download, verify and atomically install the pinned CLI; None on failure."""
    import installer_utils

    if not _has_free_space(cache_dir, pinned.get('size')):
        return None

    final_path = os.path.join(cache_dir, get_cli_filename())
    partial_path = os.path.join(cache_dir, get_partial_filename())
    size_label = (
        f"{pinned['size'] / (1024 * 1024):.1f} MB" if pinned.get('size') else 'unknown size'
    )

    logger.info(
        f"Fetching Claude CLI {pinned['version']} ({size_label}) from "
        f"{_redact_url(pinned['downloadUrl'])}"
    )

    for attempt in range(1, MAX_DOWNLOAD_ATTEMPTS + 1):
        # download_file relocates a locked destination, so only its returned
        # path is safe to act on.
        success, actual_path = installer_utils.download_file(
            pinned['downloadUrl'],
            partial_path,
            progress_callback=_make_progress_logger(size_label),
        )

        if not success or not actual_path:
            # Its 3 transport retries are already spent.
            logger.error(f"Claude CLI download failed (attempt {attempt}/{MAX_DOWNLOAD_ATTEMPTS})")
            return None

        if not installer_utils.verify_checksum(actual_path, pinned['sha256']):
            logger.error(
                f"Claude CLI checksum rejected (attempt {attempt}/{MAX_DOWNLOAD_ATTEMPTS}) — "
                "discarding the download"
            )
            try:
                os.remove(actual_path)
            except OSError:
                pass
            continue

        try:
            # Mode and group first: the rename then publishes a runnable
            # binary in one step, and a chmod failure discards the download like
            # any other. 0o750 is only reachable by the kiosk user's hoot
            # process if the daemon's group owns the file, and the data-root
            # mode table ran long before this download.
            _apply_executable_mode(actual_path)
            shared_utils.grant_data_group(actual_path)
            os.replace(actual_path, final_path)
        except OSError as e:
            logger.error(f"Could not install the Claude CLI to {final_path}: {e}")
            try:
                os.remove(actual_path)
            except OSError:
                pass
            return None

        _write_sidecar(final_path, pinned['version'], pinned['sha256'], source='download')
        logger.info(f"Claude CLI {pinned['version']} installed: {final_path}")
        return final_path

    return None


def ensure_cli(db=None) -> Optional[str]:
    """Absolute path to a usable Claude Code CLI, or None.

    Resolution order is in the module docstring. NEVER raises — every failure
    returns None so the caller reports a status instead of crash-looping.
    """
    cache_dir = get_cache_dir()
    try:
        os.makedirs(cache_dir, exist_ok=True)
    except OSError as e:
        # Not fatal — a bundled copy may still rescue us.
        logger.error(f"Could not create the CLI cache directory {cache_dir}: {e}")

    pinned = read_pinned_metadata(db)
    sidecar = _read_json(_sidecar_path())

    # 1. Already verified, intact, matching the pin.
    cached = _sidecar_binary(sidecar, pinned)
    if cached:
        source = sidecar.get('source', 'cache') if sidecar else 'cache'
        logger.info(
            f"Claude CLI {sidecar.get('version')} ready from {source}: {cached}"
        )
        return cached

    # Metadata unreachable, nothing verified on disk — best effort only.
    if pinned is None:
        fallback = _unverified_fallback(cache_dir)
        if fallback:
            logger.warning("Cortex CLI metadata unavailable — using an unverified CLI on disk")
            return fallback
        _record_fetch_failure('cortex_cli metadata unavailable')
        logger.error("Cortex CLI metadata unavailable and no CLI on disk")
        return None

    # 2. Hashing what we have beats a 241.5 MB download.
    adopted = _adopt_local_candidate(pinned, cache_dir)
    if adopted:
        _clear_fetch_failures()
        return adopted

    # 3. Download, unless still backing off from earlier failures.
    backoff = _fetch_backoff_remaining()
    if backoff > 0:
        logger.warning(
            f"Skipping the Claude CLI fetch — backing off for another {int(backoff)}s "
            "after repeated failures"
        )
        return _unverified_fallback(cache_dir)

    installed = _download_and_verify(pinned, cache_dir)
    if installed:
        _clear_fetch_failures()
        return installed

    # 4. An unverified copy on disk beats no Cortex at all.
    _record_fetch_failure('download or checksum verification failed')
    return _unverified_fallback(cache_dir)


def _adopt_local_candidate(pinned: Dict[str, Any], cache_dir: str) -> Optional[str]:
    """Adopt an on-disk binary whose sha256 already matches the pin: a cached one
    with a lost sidecar, or the SDK copy left by an in-place 2.x upgrade. A
    cached binary that fails is deleted, or every start re-hashes it.
    """
    import installer_utils

    cached = os.path.join(cache_dir, get_cli_filename())
    candidates = []
    if os.path.isfile(cached):
        candidates.append((cached, 'download'))
    bundled = get_bundled_cli_path()
    if bundled and os.path.normcase(bundled) != os.path.normcase(cached):
        candidates.append((bundled, 'bundled'))

    for path, source in candidates:
        logger.info(f"Checking an existing Claude CLI against the pin: {path}")
        if installer_utils.verify_checksum(path, pinned['sha256']):
            _ensure_executable(path)
            _write_sidecar(path, pinned['version'], pinned['sha256'], source=source)
            logger.info(
                f"Adopted the existing Claude CLI {pinned['version']} ({source}) — "
                "download skipped"
            )
            return path

        if source == 'download':
            logger.warning(f"Cached Claude CLI failed the pin — deleting {path}")
            try:
                os.remove(path)
            except OSError as e:
                logger.warning(f"Could not delete the rejected CLI {path}: {e}")

    return None


def _unverified_fallback(cache_dir: str) -> Optional[str]:
    """Last resort: any on-disk binary, unmatched against the pin. Reached only
    when the pin cannot be satisfied. The cached binary wins over the bundled
    copy — it WAS verified when written, even if the sidecar is now gone.
    """
    for path, label in (
        (os.path.join(cache_dir, get_cli_filename()), 'cached'),
        (get_bundled_cli_path(), 'SDK-bundled'),
    ):
        if path and os.path.isfile(path):
            logger.warning(f"Using the {label} Claude CLI without verification: {path}")
            return _ensure_executable(path)

    logger.error(
        "No Claude CLI available — Cortex cannot start. Check network access to "
        "Firebase Storage and retry once connectivity is restored."
    )
    return None
