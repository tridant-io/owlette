"""
sync_downloader — parallel chunk fetcher for roost (project distribution v2).

downloads content-addressed chunks (4 MiB each) from R2 signed URLs into
the local content store at <data root>/content/{hash[0:2]}/{hash}. the content
store is a rebuildable cache — it lives OUTSIDE the user's Documents tree
so operators never see it mixed with assembled files, and so LocalSystem
doesn't have to stash it under `C:\Windows\System32\config\systemprofile\`.
chunks are deleted by sync_assembler immediately after successful assembly
(R2 retains the canonical copies; re-sync + rollback re-download).

design:
- thread pool of N workers (default 4) downloads chunks in parallel
- range-request resume: a partial download (`<hash>.partial`) is resumed
  by sending `Range: bytes=<offset>-` rather than re-fetching from byte 0
- per-chunk SHA-256 verification: the chunk's filename IS its hash;
  bytes that don't match are deleted and the chunk is re-queued
- url refresh: signed urls expire (≤15 min for downloads); the caller
  passes a `url_provider(hash) -> str` callback the worker calls when
  a 403 / expired-url response is received
- cancellation: a `cancel_event` (threading.Event) is checked between
  chunks AND between range-requests within a single chunk
- per-chunk retry budget (default 5) with exponential backoff
- updates SyncState rows so progress survives crash/restart

NOT this module's job:
- chunk-set planning (sync_version provides the diff)
- file reassembly (sync_assembler reads from content store)
- signed-url issuance (web/api/chunks/download-urls; passed via url_provider)
"""

from __future__ import annotations

import hashlib
import logging
import os
import threading
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from dataclasses import dataclass
from pathlib import Path
from typing import Callable, Dict, Iterable, List, Optional

import requests
import threading as _threading_for_lock  # alias to avoid shadowing param `threading.Event`

import shared_utils
from sync_state import SyncState

logger = logging.getLogger(__name__)

# one global pool for all distributions — chunks are content-addressed, so
# dedup is automatic. sync_assembler and sync_scrub import this resolver.
def _default_content_store() -> str:
    """
    default content-store path: `content` under the agent's data root.

    Same rationale as sync_state._default_state_db_path(): cache data belongs
    neither in the user's Documents nor in System32 under LocalSystem.
    """
    return shared_utils.get_data_path('content')


# tuning constants
DEFAULT_CONCURRENCY = 4
DEFAULT_PER_CHUNK_RETRY_BUDGET = 5
DEFAULT_RETRY_BACKOFF_BASE_S = 2.0
DEFAULT_RETRY_BACKOFF_MAX_S = 60.0
# Must stay <= the server's MAX_HASHES_PER_REQUEST (1000). 500 leaves headroom
# and keeps each payload inside a typical TLS write window.
URL_PREFETCH_BATCH_SIZE = 500

# HTTP timing — same shape as installer_utils + sync_version.
_CONNECT_TIMEOUT_S = 30
_READ_TIMEOUT_S = 600
_STREAM_CHUNK_BYTES = 64 * 1024


class ChunkDownloadError(Exception):
    """raised when a chunk repeatedly fails (after retry budget exhausted)."""
    pass


@dataclass
class DownloadResult:
    """summary returned by download_all() — for the caller's progress UI."""
    fetched: int          # chunks newly downloaded this run
    already_present: int  # chunks already in content store (dedup hits)
    failed: int           # chunks that hit retry budget
    cancelled: bool       # True if cancel_event triggered before completion


def chunk_path(content_store: Path, chunk_hash: str) -> Path:
    """
    canonical on-disk path for a chunk. sharded by the first two hex chars: a
    500GB project is ~125k chunks and a flat dir is slow on NTFS.
    """
    return content_store / chunk_hash[:2] / chunk_hash


def has_chunk(content_store: Path, chunk_hash: str, expected_size: int) -> bool:
    """
    true only when size AND SHA-256 both match. a `<hash>.partial` is not
    present — it triggers a resume.
    """
    target = chunk_path(content_store, chunk_hash)
    if not target.exists():
        return False
    try:
        if target.stat().st_size != expected_size:
            logger.warning(
                f"sync_downloader: chunk {chunk_hash[:12]}… on disk has wrong size "
                f"({target.stat().st_size} vs expected {expected_size}); will refetch"
            )
            target.unlink(missing_ok=True)
            return False
    except OSError as e:
        logger.warning(f"sync_downloader: stat failed for {target}: {e}")
        return False
    if _hash_file(target) != chunk_hash:
        logger.warning(
            f"sync_downloader: chunk {chunk_hash[:12]}… on disk has wrong hash; will refetch"
        )
        target.unlink(missing_ok=True)
        return False
    return True


def download_all(
    distribution_id: int,
    chunks: Iterable[dict],  # [{hash, size}]
    url_provider: Callable[[List[str]], Dict[str, str]],
    state: SyncState,
    cancel_event: Optional[threading.Event] = None,
    content_store: Optional[str] = None,
    concurrency: int = DEFAULT_CONCURRENCY,
    retry_budget: int = DEFAULT_PER_CHUNK_RETRY_BUDGET,
    progress_cb: Optional[Callable[[int, int], None]] = None,
) -> DownloadResult:
    """
    fetch every chunk into the content store, skipping dedup hits. progress is
    recorded in SyncState.

    url_provider(hashes) -> {hash: url}: BATCH form, <= URL_PREFETCH_BATCH_SIZE
    hashes per call. called upfront to fill a cache, then per-hash on 403.

    cancel_event: workers stop after their current chunk.

    raises ChunkDownloadError if ANY chunk exhausts its retry budget.
    """
    if cancel_event is None:
        cancel_event = threading.Event()  # never-fires sentinel
    # Re-resolved per call for test env overrides. expanduser still applies to a
    # caller-supplied path — callers pass `~/...` and that contract is public.
    if content_store is None:
        store = Path(_default_content_store())
    else:
        store = Path(os.path.expanduser(content_store))
    store.mkdir(parents=True, exist_ok=True)

    chunks_list = list(chunks)
    fetched = 0
    already_present = 0
    failed = 0

    # Dedup before spawning workers: on the common re-publish most chunks are
    # unchanged and not worth a thread.
    pending: List[dict] = []
    for c in chunks_list:
        if cancel_event.is_set():
            break
        if has_chunk(store, c['hash'], c['size']):
            already_present += 1
            state.set_chunk_state(distribution_id, c['hash'], 'verified')
        else:
            pending.append(c)

    if not pending:
        return DownloadResult(
            fetched=0, already_present=already_present, failed=0,
            cancelled=cancel_event.is_set(),
        )

    logger.info(
        f"sync_downloader: distribution {distribution_id}: "
        f"{already_present} dedup hits, {len(pending)} chunks to fetch "
        f"(concurrency={concurrency})"
    )

    # 25 round-trips instead of 12,500 for a 12.5k-chunk distribution. workers
    # read the cache; a 403 (url expired mid-download) falls back to a
    # single-hash refetch in _per_hash_lookup.
    url_cache: Dict[str, str] = {}
    cache_lock = _threading_for_lock.Lock()
    pending_hashes = [c['hash'] for c in pending]
    for i in range(0, len(pending_hashes), URL_PREFETCH_BATCH_SIZE):
        if cancel_event.is_set():
            break
        batch = pending_hashes[i:i + URL_PREFETCH_BATCH_SIZE]
        try:
            urls = url_provider(batch)
        except Exception as e:
            logger.error(
                f"sync_downloader: bulk url prefetch failed for batch of "
                f"{len(batch)} chunks: {e}"
            )
            raise ChunkDownloadError(f"bulk url prefetch failed: {e}") from e
        if not isinstance(urls, dict):
            raise ChunkDownloadError(
                f"url_provider returned {type(urls).__name__}, expected dict"
            )
        with cache_lock:
            url_cache.update(urls)
    logger.debug(
        f"sync_downloader: prefetched {len(url_cache)} urls "
        f"in {(len(pending_hashes) + URL_PREFETCH_BATCH_SIZE - 1) // URL_PREFETCH_BATCH_SIZE} batch(es)"
    )

    # _download_one calls _per_hash_lookup once per attempt, so call 1 may use
    # the prefetched url and every later call must force a refetch — otherwise a
    # retry on an expired url just gets the same expired url forever.
    url_call_counts: Dict[str, int] = {}

    def _per_hash_lookup(chunk_hash: str) -> str:
        """cache hit on the first call, forced refetch on every retry."""
        with cache_lock:
            n = url_call_counts.get(chunk_hash, 0) + 1
            url_call_counts[chunk_hash] = n
            if n == 1:
                url = url_cache.get(chunk_hash)
            else:
                # retry: assume the previous url is stale.
                url_cache.pop(chunk_hash, None)
                url = None
        if url:
            return url
        result = url_provider([chunk_hash])
        if not isinstance(result, dict):
            raise ChunkDownloadError(
                f"url_provider returned {type(result).__name__}, expected dict"
            )
        with cache_lock:
            url_cache.update(result)
        url = result.get(chunk_hash)
        if not url:
            raise ChunkDownloadError(
                f"url_provider did not return a url for {chunk_hash[:12]}…"
            )
        return url

    # Snapshot BEFORE we set cancel_event ourselves on failure, so the result
    # can tell "user cancelled" from "chunk failure short-circuit".
    was_externally_cancelled = cancel_event.is_set()

    # Total spans dedup hits + fetches so the UI reaches 100%. Emit once
    # up front to show the dedup baseline before any download lands.
    total_chunks = already_present + len(pending)
    if progress_cb:
        try:
            progress_cb(already_present, total_chunks)
        except Exception:
            pass  # best-effort

    with ThreadPoolExecutor(max_workers=concurrency) as pool:
        futures = {
            pool.submit(
                _download_one,
                c['hash'], c['size'], store, _per_hash_lookup,
                state, distribution_id, cancel_event, retry_budget,
            ): c
            for c in pending
        }
        for fut in as_completed(futures):
            c = futures[fut]
            try:
                fut.result()
                fetched += 1
                if progress_cb:
                    try:
                        progress_cb(already_present + fetched, total_chunks)
                    except Exception:
                        pass
            except ChunkDownloadError:
                failed += 1
                # _download_one already marked state 'failed'; cancel to
                # short-circuit in-flight workers.
                cancel_event.set()
            except Exception as e:
                logger.error(
                    f"sync_downloader: unexpected error on {c['hash'][:12]}…: {e}",
                    exc_info=True,
                )
                state.set_chunk_state(
                    distribution_id, c['hash'], 'failed',
                    error=f"{type(e).__name__}: {e}",
                )
                failed += 1
                cancel_event.set()

    result = DownloadResult(
        fetched=fetched,
        already_present=already_present,
        failed=failed,
        cancelled=was_externally_cancelled and failed == 0,
    )
    logger.info(
        f"sync_downloader: distribution {distribution_id} complete: "
        f"fetched={fetched} dedup={already_present} failed={failed} "
        f"cancelled={result.cancelled}"
    )
    # Failure raises; external cancellation returns peacefully with
    # result.cancelled set.
    if failed > 0:
        raise ChunkDownloadError(
            f"distribution {distribution_id}: {failed} chunk(s) failed "
            f"after retry budget exhausted"
        )
    return result


def _download_one(
    chunk_hash: str,
    expected_size: int,
    content_store: Path,
    url_provider: Callable[[str], str],
    state: SyncState,
    distribution_id: int,
    cancel_event: threading.Event,
    retry_budget: int,
) -> None:
    """download a single chunk with range-resume + retries. raises on exhaustion."""
    target = chunk_path(content_store, chunk_hash)
    target.parent.mkdir(parents=True, exist_ok=True)
    partial = target.with_suffix(target.suffix + '.partial')

    state.set_chunk_state(distribution_id, chunk_hash, 'downloading')
    last_err: Optional[Exception] = None

    for attempt in range(1, retry_budget + 1):
        if cancel_event.is_set():
            logger.debug(f"sync_downloader: {chunk_hash[:12]}… cancelled before attempt {attempt}")
            return
        try:
            offset = partial.stat().st_size if partial.exists() else 0
            if offset >= expected_size:
                # corrupt partial — start over
                partial.unlink(missing_ok=True)
                offset = 0

            url = url_provider(chunk_hash)
            headers = {}
            if offset > 0:
                headers['Range'] = f'bytes={offset}-'
                logger.debug(
                    f"sync_downloader: resuming {chunk_hash[:12]}… from offset {offset}"
                )

            resp = requests.get(
                url,
                headers=headers,
                timeout=(_CONNECT_TIMEOUT_S, _READ_TIMEOUT_S),
                stream=True,
                allow_redirects=True,
            )
            # Signed url expired: refetch and retry with no backoff.
            if resp.status_code in (403, 401):
                logger.info(
                    f"sync_downloader: {chunk_hash[:12]}… got {resp.status_code}; "
                    f"refreshing signed url"
                )
                resp.close()
                continue
            # 416 means our Range is past the file — the partial is corrupt.
            if resp.status_code == 416:
                logger.warning(
                    f"sync_downloader: {chunk_hash[:12]}… got 416 (range past file); "
                    f"deleting partial + restarting"
                )
                partial.unlink(missing_ok=True)
                resp.close()
                continue
            resp.raise_for_status()

            mode = 'ab' if offset > 0 else 'wb'
            with open(partial, mode) as f:
                for buf in resp.iter_content(chunk_size=_STREAM_CHUNK_BYTES):
                    if cancel_event.is_set():
                        logger.debug(
                            f"sync_downloader: {chunk_hash[:12]}… cancelled mid-stream"
                        )
                        resp.close()
                        return
                    if buf:
                        f.write(buf)

            if partial.stat().st_size != expected_size:
                raise ChunkDownloadError(
                    f"size mismatch: got {partial.stat().st_size} expected {expected_size}"
                )
            actual = _hash_file(partial)
            if actual != chunk_hash:
                # bad bytes on the wire, or storage corruption.
                logger.warning(
                    f"sync_downloader: {chunk_hash[:12]}… hash mismatch "
                    f"(got {actual[:12]}…); discarding + retrying"
                )
                partial.unlink(missing_ok=True)
                last_err = ChunkDownloadError(f"hash mismatch (got {actual})")
                _backoff(attempt)
                continue

            # os.replace is atomic — a torn file is never visible as complete.
            os.replace(str(partial), str(target))
            state.set_chunk_state(distribution_id, chunk_hash, 'verified')
            return

        except requests.RequestException as e:
            last_err = e
            logger.warning(
                f"sync_downloader: {chunk_hash[:12]}… attempt {attempt}/{retry_budget} "
                f"network error: {e}"
            )
            _backoff(attempt)
        except OSError as e:
            last_err = e
            logger.warning(
                f"sync_downloader: {chunk_hash[:12]}… attempt {attempt}/{retry_budget} "
                f"disk error: {e}"
            )
            _backoff(attempt)
        except ChunkDownloadError as e:
            last_err = e
            logger.warning(
                f"sync_downloader: {chunk_hash[:12]}… attempt {attempt}/{retry_budget}: {e}"
            )
            _backoff(attempt)

    # retry budget exhausted
    state.set_chunk_state(
        distribution_id, chunk_hash, 'failed',
        error=f"after {retry_budget} attempts: {last_err}",
        increment_attempts=True,
    )
    raise ChunkDownloadError(
        f"chunk {chunk_hash[:12]}… failed after {retry_budget} attempts: {last_err}"
    )


def _backoff(attempt: int) -> None:
    wait = min(
        DEFAULT_RETRY_BACKOFF_BASE_S * (2 ** (attempt - 1)),
        DEFAULT_RETRY_BACKOFF_MAX_S,
    )
    time.sleep(wait)


def _hash_file(path: Path) -> str:
    """compute the lowercase-hex SHA-256 of a file's contents."""
    h = hashlib.sha256()
    with open(path, 'rb') as f:
        while True:
            buf = f.read(_STREAM_CHUNK_BYTES)
            if not buf:
                break
            h.update(buf)
    return h.hexdigest()
