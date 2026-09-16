"""
sync_scrub — periodic on-disk integrity verification for roost.

Re-hashes every assembled file's CONTENTS, not size+mtime: mtime alone misses
silent bit-rot on never-modified files. Drift is reported to firestore so the
dashboard can surface "machine X has corrupted file Y".

- driven by a separate scheduler, never the main loop
- only CURRENT, committed versions; older versions may legitimately have been
  overwritten by later distributions
- chunked SHA-256 so a 50GB file doesn't OOM the agent
- skips files already in 'failed' state

Also owns the local content-store reaper (`reap_orphan_chunks`) — without it a
failed distribution keeps every byte it downloaded, forever.

Not here: triggering the scrub, repairing drift, R2-side chunk GC.
"""

from __future__ import annotations

import hashlib
import json
import logging
import os
import re
import time
from dataclasses import asdict, dataclass, field
from pathlib import Path
from typing import Iterable, List, Optional, Tuple

import shared_utils
from sync_downloader import _default_content_store
from sync_version import Version, VersionFile, fetch_version, VersionError
from sync_state import SyncState

logger = logging.getLogger(__name__)

def _default_scrub_report_dir() -> str:
    """
    default report dir: `scrub-reports` under the agent's data root.

    See sync_state._default_state_db_path() for why `~/Documents/` is avoided
    under LocalSystem.
    """
    return shared_utils.get_data_path('scrub-reports')


_SCRUB_BUFFER_BYTES = 1024 * 1024  # 1 MiB read buffer

# Hourly scrub dispatch would otherwise grow this dir forever; only recent
# reports have debugging value.
MAX_SCRUB_REPORTS = 50
MAX_SCRUB_REPORT_AGE_SECONDS = 30 * 24 * 3600

# Minimum age before the reaper touches an unreferenced chunk. Covers the gap
# between "blob written" and "chunk row visible in an active distribution",
# plus unknown out-of-band writers; bounds any leak to one day.
DEFAULT_ORPHAN_MIN_AGE_SECONDS = 24 * 3600

# Chunk filenames are lowercase sha-256 hex, optionally `.partial` mid-download.
# Anything else in the store isn't ours to touch.
_CHUNK_NAME_RE = re.compile(r'^([0-9a-f]{64})(\.partial)?$')


@dataclass
class FileDrift:
    """one drift entry: a file that doesn't match its version entry."""
    path: str
    expected_size: int
    actual_size: Optional[int]  # None if the file is missing
    reason: str  # 'missing', 'size_mismatch', 'hash_mismatch', 'read_error'
    error: Optional[str] = None  # populated for 'read_error'


@dataclass
class ScrubReport:
    """summary of one scrub run for one distribution."""
    distribution_id: int
    site_id: str
    roost_id: str
    version_id: str
    extract_root: str
    started_at: float
    finished_at: float
    files_checked: int
    files_skipped: int  # files in 'failed' state
    drifts: List[FileDrift] = field(default_factory=list)

    @property
    def healthy(self) -> bool:
        return len(self.drifts) == 0


def scrub_distribution(
    distribution_id: int,
    extract_root: str,
    state: SyncState,
    report_dir: Optional[str] = None,
) -> ScrubReport:
    """
    re-verify on-disk contents against the version; returns a ScrubReport for
    the caller to persist/upload.

    extract_root must be passed because the version doesn't carry the
    extraction destination — that lives in config + the sync_pull payload.
    """
    started = time.time()
    dist_row = state.get_distribution(distribution_id)
    if dist_row is None:
        raise ValueError(f"distribution {distribution_id} not found in state")

    # In-flight distributions race sync_assembler and produce false drifts.
    if dist_row['state'] != 'committed':
        raise ValueError(
            f"distribution {distribution_id} is in state {dist_row['state']!r}; "
            f"only 'committed' distributions are scrub-eligible"
        )

    # Same cached version sync_assembler wrote the files from.
    try:
        version = fetch_version(
            dist_row['version_url'],
            expected_version_id=dist_row['version_id'],
        )
    except VersionError as e:
        raise ValueError(
            f"could not load version {dist_row['version_id']!r} for scrub: {e}"
        ) from e

    failed_paths = {row['path'] for row in state.list_files(distribution_id, state='failed')}

    drifts: List[FileDrift] = []
    files_checked = 0
    files_skipped = 0
    extract_path = Path(os.path.expanduser(extract_root))
    for f in version.files:
        if f.path in failed_paths:
            files_skipped += 1
            continue
        files_checked += 1
        drift = _check_file(extract_path, f)
        if drift is not None:
            drifts.append(drift)

    finished = time.time()
    report = ScrubReport(
        distribution_id=distribution_id,
        site_id=dist_row['site_id'],
        roost_id=dist_row['roost_id'],
        version_id=dist_row['version_id'],
        extract_root=str(extract_path),
        started_at=started,
        finished_at=finished,
        files_checked=files_checked,
        files_skipped=files_skipped,
        drifts=drifts,
    )

    # Default recomputed per call so an OWLETTE_DATA_ROOT override applies.
    _write_report(report, report_dir or _default_scrub_report_dir())

    if report.healthy:
        logger.info(
            f"sync_scrub: distribution {distribution_id} HEALTHY "
            f"({files_checked} files in {finished - started:.1f}s)"
        )
    else:
        logger.warning(
            f"sync_scrub: distribution {distribution_id} DRIFT — "
            f"{len(drifts)} of {files_checked} files mismatch"
        )

    return report


def _check_file(extract_root: Path, version_file: VersionFile) -> Optional[FileDrift]:
    """
    verify one file against the version: None on match, FileDrift on mismatch.
    Re-hashes CONTENTS, so it catches truncation, bit-rot, AV interference and
    manual edits — not just missing files.
    """
    target_relative = Path(*version_file.path.split('/'))
    target = extract_root / target_relative

    if not target.exists():
        return FileDrift(
            path=version_file.path,
            expected_size=version_file.size,
            actual_size=None,
            reason='missing',
        )

    try:
        actual_size = target.stat().st_size
    except OSError as e:
        return FileDrift(
            path=version_file.path, expected_size=version_file.size,
            actual_size=None, reason='read_error', error=f"stat: {e}",
        )

    if actual_size != version_file.size:
        return FileDrift(
            path=version_file.path, expected_size=version_file.size,
            actual_size=actual_size, reason='size_mismatch',
        )

    # The version stores PER-CHUNK hashes, so slice the file identically and
    # verify each chunk — a whole-file digest would not match anything.
    try:
        if not _verify_chunks(target, version_file):
            return FileDrift(
                path=version_file.path, expected_size=version_file.size,
                actual_size=actual_size, reason='hash_mismatch',
            )
    except OSError as e:
        return FileDrift(
            path=version_file.path, expected_size=version_file.size,
            actual_size=actual_size, reason='read_error', error=f"read: {e}",
        )

    return None


def _verify_chunks(target: Path, version_file: VersionFile) -> bool:
    """
    slice the file into the version's declared chunk sizes and verify each
    SHA-256. False on the first mismatch — early exit on large corrupt files.
    """
    with open(target, 'rb') as f:
        for i, chunk in enumerate(version_file.chunks):
            remaining = chunk.size
            h = hashlib.sha256()
            while remaining > 0:
                buf = f.read(min(_SCRUB_BUFFER_BYTES, remaining))
                if not buf:
                    return False  # short read — file truncated
                h.update(buf)
                remaining -= len(buf)
            if h.hexdigest() != chunk.hash:
                return False
    return True


def scrub_all_due(
    state: SyncState,
    max_age_seconds: int = 30 * 24 * 3600,  # 30 days
    report_dir: Optional[str] = None,
) -> List[ScrubReport]:
    """
    scrub every committed distribution whose last_scrub_at is older than
    max_age_seconds (or never), marking each scrubbed on success.

    Call from slow_command_worker, NEVER the 5s main loop — a scrub can take
    minutes. One failure doesn't stop the rest.
    """
    due = state.list_scrub_due(max_age_seconds)
    if not due:
        logger.debug("sync_scrub: no distributions due for scrub")
        return []

    logger.info(f"sync_scrub: {len(due)} distribution(s) due for scrub")
    reports: List[ScrubReport] = []
    for row in due:
        try:
            report = scrub_distribution(
                row['id'], row['extract_root'], state, report_dir=report_dir,
            )
            reports.append(report)
            # Mark even on drift — the scrub itself succeeded. Only a
            # fail-to-run skips the mark so the next pass retries.
            state.mark_scrubbed(row['id'])
        except (ValueError, OSError) as e:
            logger.error(
                f"sync_scrub: failed to scrub distribution {row['id']}: {e}"
            )
    return reports


@dataclass
class ReapReport:
    """summary of one content-store reap pass."""
    scanned: int = 0            # chunk-shaped files examined
    deleted: int = 0            # removed, or selected when dry_run
    bytes_freed: int = 0
    kept_referenced: int = 0    # still needed by an in-flight distribution
    kept_recent: int = 0        # younger than min_age_seconds
    kept_unrecognized: int = 0  # not a chunk filename — never ours to delete
    failed: int = 0             # delete errors (locked file, ACL, AV)
    dry_run: bool = False
    deleted_hashes: List[str] = field(default_factory=list)


def reap_orphan_chunks(
    state: SyncState,
    content_store: Optional[str] = None,
    min_age_seconds: int = DEFAULT_ORPHAN_MIN_AGE_SECONDS,
    dry_run: bool = False,
) -> ReapReport:
    """
    delete cached chunks no in-flight distribution needs. Reaped only when BOTH:
      1. unreferenced by any ACTIVE_DISTRIBUTION_STATES row (committed/failed/
         cancelled are history and never resume), and
      2. older than `min_age_seconds` — guards a distribution that wrote blobs
         before registering its rows.

    `.partial` sidecars follow the same rules. Best-effort: an undeletable file
    is counted and logged, never raised. `dry_run` selects without deleting.
    """
    store = Path(os.path.expanduser(content_store or _default_content_store()))
    report = ReapReport(dry_run=dry_run)
    if not store.is_dir():
        logger.debug(f"sync_scrub: content store {store} does not exist — nothing to reap")
        return report

    referenced = state.list_referenced_chunk_hashes()
    cutoff = time.time() - max(0, min_age_seconds)

    for path, chunk_hash in _iter_content_store(store, report):
        report.scanned += 1
        if chunk_hash in referenced:
            report.kept_referenced += 1
            continue
        try:
            st = path.stat()
        except OSError:
            continue  # vanished between scandir and stat
        if st.st_mtime > cutoff:
            report.kept_recent += 1
            continue
        if dry_run:
            report.deleted += 1
            report.bytes_freed += st.st_size
            report.deleted_hashes.append(chunk_hash)
            continue
        try:
            path.unlink()
        except OSError as e:
            report.failed += 1
            logger.warning(
                f"sync_scrub: could not reap orphan chunk {path.name[:12]}… "
                f"at {path!s}: {e}"
            )
            continue
        report.deleted += 1
        report.bytes_freed += st.st_size
        report.deleted_hashes.append(chunk_hash)
        logger.debug(f"sync_scrub: reaped orphan chunk {path.name} ({st.st_size} bytes)")

    if report.deleted or report.failed:
        # Capped sample: a 125k-chunk store must not write 125k log lines.
        sample = ', '.join(h[:12] + '…' for h in report.deleted_hashes[:10])
        more = '' if len(report.deleted_hashes) <= 10 else f" (+{len(report.deleted_hashes) - 10} more)"
        verb = 'would reap' if dry_run else 'reaped'
        logger.info(
            f"sync_scrub: content-store reap — {verb} {report.deleted} orphan "
            f"chunk(s), {report.bytes_freed / (1024 * 1024):.1f} MiB; kept "
            f"{report.kept_referenced} referenced + {report.kept_recent} recent; "
            f"{report.failed} failed. hashes: {sample}{more}"
        )
    else:
        logger.debug(
            f"sync_scrub: content-store reap — nothing to collect "
            f"({report.scanned} chunk(s) scanned, {report.kept_referenced} referenced, "
            f"{report.kept_recent} too recent)"
        )
    return report


def _iter_content_store(store: Path, report: ReapReport) -> Iterable[Tuple[Path, str]]:
    """
    yield (path, chunk_hash) for each chunk-shaped file in the sharded store
    (`<store>/<2 hex>/<64 hex>[.partial]`).

    Non-files, symlinks and off-pattern names count as kept_unrecognized: the
    reaper only deletes what it can prove it wrote.
    """
    try:
        with os.scandir(str(store)) as shards:
            shard_entries = list(shards)
    except OSError as e:
        logger.warning(f"sync_scrub: cannot list content store {store}: {e}")
        return
    for shard in shard_entries:
        try:
            if not shard.is_dir(follow_symlinks=False):
                report.kept_unrecognized += 1
                continue
            with os.scandir(shard.path) as it:
                entries = list(it)
        except OSError as e:
            logger.warning(f"sync_scrub: cannot list content-store shard {shard.path}: {e}")
            continue
        for entry in entries:
            try:
                if not entry.is_file(follow_symlinks=False):
                    report.kept_unrecognized += 1
                    continue
            except OSError:
                continue
            m = _CHUNK_NAME_RE.match(entry.name)
            if m is None:
                report.kept_unrecognized += 1
                continue
            yield Path(entry.path), m.group(1)


def _write_report(report: ScrubReport, report_dir: str) -> None:
    """
    write the report as JSON for local debugging, then trim the directory.

    Best-effort: write errors warn and return: an unwritable report dir must
    not break the agent.
    """
    rd = Path(os.path.expanduser(report_dir))
    fname = f"scrub_{report.distribution_id}_{int(report.finished_at)}.json"
    target = rd / fname
    try:
        rd.mkdir(parents=True, exist_ok=True)
        target.write_text(
            json.dumps(asdict(report), indent=2),
            encoding='utf-8',
        )
    except OSError as e:
        logger.warning(f"sync_scrub: could not persist report to {target}: {e}")
        return
    _prune_old_reports(rd)


def _prune_old_reports(
    report_dir: Path,
    keep: int = MAX_SCRUB_REPORTS,
    max_age_seconds: int = MAX_SCRUB_REPORT_AGE_SECONDS,
) -> int:
    """
    delete reports beyond the newest `keep` or older than `max_age_seconds`;
    returns the count. Nothing else cleans this dir — cleanup_old_logs only
    walks the logs root for `*.log`.

    Only `scrub_*.json` is considered, and delete failures are swallowed.
    """
    try:
        entries = [p for p in report_dir.glob('scrub_*.json') if p.is_file()]
    except OSError as e:
        logger.warning(f"sync_scrub: could not list report dir {report_dir}: {e}")
        return 0

    stamped = []
    for p in entries:
        try:
            stamped.append((p.stat().st_mtime, p))
        except OSError:
            continue
    stamped.sort(key=lambda t: t[0], reverse=True)  # newest first

    cutoff = time.time() - max_age_seconds
    deleted = 0
    for index, (mtime, path) in enumerate(stamped):
        if index < keep and mtime >= cutoff:
            continue
        try:
            path.unlink()
            deleted += 1
        except OSError as e:
            logger.warning(f"sync_scrub: could not delete old report {path}: {e}")
    if deleted:
        logger.info(
            f"sync_scrub: trimmed {deleted} old scrub report(s) from {report_dir} "
            f"(keeping the newest {keep} within {max_age_seconds // 86400}d)"
        )
    return deleted
