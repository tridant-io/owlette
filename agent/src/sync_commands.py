"""
sync_commands — roost (project distribution v2) command handlers.

Registers `sync_pull`, `cancel_sync`, `rollback_to_version` with the
CommandRouter. Handlers run on `_slow_command_worker`, NOT the main 10-second
loop, so blocking sync ops don't stall monitoring.

Pure orchestration: validate payload, check the destination BEFORE any egress,
fetch the version, diff against the local cache, download chunks, assemble
atomically, and keep SyncState + firestore updated throughout. The IO modules
(sync_version / sync_downloader / sync_assembler / destination_allowlist) own
their own logic and tests.

Cancellation: an in-flight sync registers its threading.Event first by
(site_id, roost_id, version_id), then by distribution_id once state exists;
cancel_sync fires through whichever key is available.

FAILURE REPORTING: a handler that could not do its job MUST return a string
starting with `Error:` (see `_failure()`). firebase_client._execute_command
keys off that prefix for status:'failed' — without it the run is recorded as a
SUCCESS, which is how refused deploys used to show up green. Failures are also
logged locally at ERROR so service.log explains them without a firestore trip.

Terminal failures release cached chunks; cancellations deliberately do not, so
a cancelled sync can resume from them.
"""

from __future__ import annotations

import logging
import threading
from typing import Any, Dict, Optional, Tuple

import destination_allowlist
from command_router import CommandRouter
from destination_allowlist import DestinationAllowlist, DestinationNotAllowedError
from roost_kill_switch import check_enabled as _roost_is_enabled
from sync_assembler import AssembleError, assemble_all, cleanup_chunks
from sync_downloader import ChunkDownloadError, download_all
from sync_version import Version, VersionError, diff_versions, fetch_version
from sync_state import SyncState, SyncStateError

try:
    from firestore_rest_client import SERVER_TIMESTAMP
except ImportError:  # pragma: no cover — only hit in isolated unit-test envs
    SERVER_TIMESTAMP = "SERVER_TIMESTAMP"

logger = logging.getLogger(__name__)

# Process-global registries so cancel_sync can fire a running sync's
# cancel_event. distribution_id is unknown until start_distribution returns, so
# setup-phase syncs are keyed by (site_id, roost_id, version_id) instead.
_SyncCancelKey = Tuple[str, str, str]
_setup_cancels: Dict[_SyncCancelKey, threading.Event] = {}
_setup_cancel_refcounts: Dict[_SyncCancelKey, int] = {}
# distribution_id -> threading.Event
_inflight_cancels: Dict[int, threading.Event] = {}
_inflight_lock = threading.Lock()


def register_pending_sync(
    site_id: str, roost_id: str, version_id: str
) -> threading.Event:
    """
    Register a sync_pull that has been accepted into the slow queue.

    The handler will later reuse this Event, so cancel_sync can be honored
    while the command is waiting for the slow worker.
    """
    cancel_key = (site_id, roost_id, version_id)
    with _inflight_lock:
        cancel_event = _setup_cancels.get(cancel_key)
        if cancel_event is None:
            cancel_event = threading.Event()
            _setup_cancels[cancel_key] = cancel_event
            _setup_cancel_refcounts[cancel_key] = 0
        _setup_cancel_refcounts[cancel_key] = (
            _setup_cancel_refcounts.get(cancel_key, 0) + 1
        )
        return cancel_event


def discard_pending_sync(
    site_id: str,
    roost_id: str,
    version_id: str,
    cancel_event: Optional[threading.Event] = None,
) -> None:
    """Release one pending/setup registration if it still matches."""
    cancel_key = (site_id, roost_id, version_id)
    with _inflight_lock:
        _discard_setup_cancel_locked(cancel_key, cancel_event)


def _ensure_setup_cancel(cancel_key: _SyncCancelKey) -> threading.Event:
    """
    Return the enqueue-registered Event for this sync, or create one for
    direct/test handler invocation that did not pass through FirebaseClient.
    """
    with _inflight_lock:
        cancel_event = _setup_cancels.get(cancel_key)
        if cancel_event is None:
            cancel_event = threading.Event()
            _setup_cancels[cancel_key] = cancel_event
            _setup_cancel_refcounts[cancel_key] = 1
        else:
            _setup_cancel_refcounts.setdefault(cancel_key, 1)
        return cancel_event


def _discard_setup_cancel_locked(
    cancel_key: _SyncCancelKey,
    cancel_event: Optional[threading.Event] = None,
) -> None:
    """Release one setup registration. Caller must hold _inflight_lock."""
    current = _setup_cancels.get(cancel_key)
    if current is None:
        return
    if cancel_event is not None and current is not cancel_event:
        return

    remaining = _setup_cancel_refcounts.get(cancel_key, 1) - 1
    if remaining <= 0:
        _setup_cancels.pop(cancel_key, None)
        _setup_cancel_refcounts.pop(cancel_key, None)
    else:
        _setup_cancel_refcounts[cancel_key] = remaining


def register_handlers(router: CommandRouter) -> None:
    """
    register all roost v2 handlers on the given CommandRouter. called once
    at OwletteService init time after the router instance is created.
    """
    router.register('sync_pull')(_handle_sync_pull)
    router.register('cancel_sync')(_handle_cancel_sync)
    router.register('rollback_to_version')(_handle_rollback_to_version)
    logger.info(
        f"sync_commands: registered handlers — {sorted(router.registered_types())}"
    )


# The extract root the fanout sends for every roost with no explicit
# extractPath. It is the windows default spelled out, and the server cannot
# know the target's OS, so a POSIX agent swaps in its own default rather than
# refusing every unconfigured deploy. Agent-side by design: no wire change, so
# fielded agents keep receiving the literal.
_LEGACY_DEFAULT_EXTRACT_ROOT = '~/Documents/Owlette'
_legacy_root_substitution_logged = False


def _substitute_legacy_default_root(extract_root: str) -> str:
    """This OS's default root in place of the server's windows-shaped one.

    Byte-identical on windows, where the literal already IS the default root.
    A root the operator chose is passed through untouched on every platform.
    """
    global _legacy_root_substitution_logged

    normalised = extract_root.replace('\\', '/').rstrip('/')
    if normalised != _LEGACY_DEFAULT_EXTRACT_ROOT:
        return extract_root
    if destination_allowlist._os_family() == 'windows':
        return extract_root

    substitute = destination_allowlist.default_roots()[0]
    if not _legacy_root_substitution_logged:
        _legacy_root_substitution_logged = True
        logger.info(
            f"sync_commands: extract root {extract_root!r} is the windows "
            f"default; using this machine's own default {substitute!r} instead"
        )
    return substitute


# handlers
def _handle_sync_pull(cmd_data: dict, cmd_id: str, service: Any) -> str:
    """
    pull a version + download missing chunks + atomically assemble files.

    cmd_data:
      site_id:        str (the agent's site; redundant with token claim but explicit)
      roost_id:       str (which roost)
      version_id:     str (which immutable version to pull)
      version_url:    str (signed R2 url to fetch the version body)
      extract_root:   str (target directory for assembled files)

    NOTE: signed download urls for individual chunks are obtained on-demand
    by sync_downloader via a callback. the callback talks to the web api
    (POST /api/chunks/download-urls) using the agent's existing OAuth token.
    """
    site_id = _require_str(cmd_data, 'site_id')
    roost_id = _require_str(cmd_data, 'roost_id')
    version_id = _require_str(cmd_data, 'version_id')
    cancel_key = (site_id, roost_id, version_id)
    cancel_event = _ensure_setup_cancel(cancel_key)
    dist_id: Optional[int] = None
    setup_entry_released = False

    def _cancelled_before_distribution(stage: str) -> Optional[str]:
        if not cancel_event.is_set():
            return None
        _report_target_state(service, site_id, roost_id, version_id, 'cancelled')
        return f"sync_pull cancelled before distribution start ({stage})"

    try:
        version_url = _require_str(cmd_data, 'version_url')
        extract_root = _substitute_legacy_default_root(
            _require_str(cmd_data, 'extract_root')
        )

        cancelled = _cancelled_before_distribution('accepted')
        if cancelled:
            return cancelled

        # Kill switch: sites/{siteId}.roostEnabled=false halts NEW roost work.
        # In-flight distributions are cancel_sync's job. Fail-open, so a
        # transient firestore blip can't pause deploys.
        try:
            if not _roost_is_enabled(site_id, _firestore_reader_for(service)):
                cancelled = _cancelled_before_distribution('kill-switch check')
                if cancelled:
                    return cancelled
                logger.warning(
                    f"sync_pull: refusing to start — roost is disabled on site {site_id!r} "
                    f"(version {version_id})"
                )
                return f"sync_pull skipped: roost kill-switch engaged for site {site_id}"
        except Exception as e:
            # The check fails open internally; this covers a throw above it.
            logger.warning(
                f"sync_pull: roost kill-switch check errored ({type(e).__name__}: {e}) — "
                f"proceeding fail-open"
            )

        cancelled = _cancelled_before_distribution('kill-switch check')
        if cancelled:
            return cancelled

        state = _state_for(service)
        allowlist = _allowlist_for(service)

        # Fail-fast so a misconfigured deploy costs ZERO egress — no version
        # body, no chunks, no signed-URL requests. The assembler re-validates
        # extract_root before writing (defense in depth + per-file checks).
        try:
            allowlist.validate(extract_root)
        except DestinationNotAllowedError as e:
            reason = (
                f"extract_root {extract_root!r} is not allowed by "
                f"destination_allowlist: {e}"
            )
            logger.error(
                f"sync_pull: REFUSED before download — {reason} "
                f"(site={site_id} roost={roost_id} version={version_id}). "
                f"allowed roots: {[str(r) for r in allowlist.roots]}"
            )
            _report_target_state(
                service, site_id, roost_id, version_id, 'failed',
                error=f"destination refused: {e}",
            )
            return _failure(f"sync_pull refused: {reason}")

        cancelled = _cancelled_before_distribution('state setup')
        if cancelled:
            return cancelled

        # 'pending' on accept, so the UI shows "target queued" before the
        # version fetch starts.
        _report_target_state(service, site_id, roost_id, version_id, 'pending')

        cancelled = _cancelled_before_distribution('pending report')
        if cancelled:
            return cancelled

        # The payload's `version_url` is either unsigned (unfetchable from a
        # private bucket) or past its 15-min TTL, so mint a fresh signed GET
        # right before the fetch. Fall back to the payload URL if minting
        # fails, rather than turning an API blip into a hard failure.
        fetch_url = version_url
        fb = getattr(service, 'firebase_client', None)
        if fb is not None and hasattr(fb, 'get_version_download_url'):
            try:
                fetch_url = fb.get_version_download_url(roost_id, version_id)
            except Exception as e:
                logger.warning(
                    f"sync_pull: failed to mint fresh version URL "
                    f"({type(e).__name__}: {e}); falling back to payload URL"
                )

        cancelled = _cancelled_before_distribution('version URL setup')
        if cancelled:
            return cancelled

        # fetch + validate version
        try:
            version = fetch_version(fetch_url, expected_version_id=version_id)
        except VersionError as e:
            cancelled = _cancelled_before_distribution('version fetch')
            if cancelled:
                return cancelled
            logger.error(
                f"sync_pull: version fetch/validate failed for "
                f"{roost_id}/{version_id}: {e}"
            )
            _report_target_state(
                service, site_id, roost_id, version_id, 'failed',
                error=f"version fetch/validate: {e}",
            )
            return _failure(f"sync_pull failed: version fetch/validate: {e}")

        cancelled = _cancelled_before_distribution('version fetch')
        if cancelled:
            return cancelled

        # diff against the most-recent committed version for this roost, if any
        prior = _load_prior_version(service, site_id, roost_id, exclude_version_id=version_id)
        diff = diff_versions(version, prior)

        cancelled = _cancelled_before_distribution('version diff')
        if cancelled:
            return cancelled

        # register the distribution + planned files/chunks
        files_planned = [{'path': f.path, 'size': f.size} for f in version.files]
        chunks_planned = [
            {'hash': h, 'size': version.chunk_size_index[h]}
            for h in sorted(version.chunks)
        ]

        cancelled = _cancelled_before_distribution('distribution setup')
        if cancelled:
            return cancelled

        try:
            dist_id = state.start_distribution(
                site_id=site_id,
                roost_id=roost_id,
                version_id=version_id,
                version_url=version_url,
                files=files_planned,
                chunks=chunks_planned,
                extract_root=extract_root,
            )
        except SyncStateError as e:
            # already exists — find it and resume
            existing = state.find_distribution(site_id, roost_id, version_id)
            if existing is None:
                cancelled = _cancelled_before_distribution('distribution start')
                if cancelled:
                    return cancelled
                logger.error(
                    f"sync_pull: could not register distribution for "
                    f"{roost_id}/{version_id} and no existing row to resume: {e}"
                )
                _report_target_state(
                    service, site_id, roost_id, version_id, 'failed',
                    error=f"sync state: {e}",
                )
                return _failure(f"sync_pull failed: state error and no existing row: {e}")
            dist_id = existing['id']
            logger.info(f"sync_pull: resuming existing distribution {dist_id}")

        with _inflight_lock:
            _inflight_cancels[dist_id] = cancel_event
            _discard_setup_cancel_locked(cancel_key, cancel_event)
            setup_entry_released = True

    finally:
        if not setup_entry_released:
            with _inflight_lock:
                _discard_setup_cancel_locked(cancel_key, cancel_event)

    assert dist_id is not None

    try:
        if cancel_event.is_set():
            state.set_distribution_state(dist_id, 'cancelled')
            _report_target_state(
                service, site_id, roost_id, version_id, 'cancelled',
            )
            return f"sync_pull cancelled before download (distribution {dist_id})"

        state.set_distribution_state(dist_id, 'downloading')
        _report_target_state(
            service, site_id, roost_id, version_id, 'downloading',
            chunks_total=len(version.chunks),
        )

        # FULL chunk set, not diff.chunks_to_fetch: post-commit cleanup
        # (sync_assembler._cleanup_content_store) deletes chunks after
        # assembly, so "unchanged" chunks may not be on disk. download_all
        # does its own has_chunk() check and skips what's present.
        # `chunks_to_fetch` is reporting-only — what's NEW vs the prior
        # version, not what this agent actually needs.
        url_provider = _make_chunk_url_provider(service)
        # Throttled: a firestore write per chunk would be a cost and
        # rate-limit problem on a 3739-chunk upload. At most once per ~2s or
        # per 5% change; the first call always goes through so the UI gets a
        # real number immediately.
        _last_emit = {'ts': 0.0, 'fetched': -1}

        def _download_progress(done: int, total: int) -> None:
            import time
            now = time.monotonic()
            elapsed = now - _last_emit['ts']
            pct_delta = (
                abs((done / total) - (_last_emit['fetched'] / total))
                if total > 0 and _last_emit['fetched'] >= 0
                else 1.0
            )
            is_terminal = done >= total
            if (
                _last_emit['fetched'] < 0
                or elapsed >= 2.0
                or pct_delta >= 0.05
                or is_terminal
            ):
                _last_emit['ts'] = now
                _last_emit['fetched'] = done
                _report_target_state(
                    service, site_id, roost_id, version_id, 'downloading',
                    chunks_fetched=done,
                    chunks_total=total,
                )

        try:
            dl_result = download_all(
                distribution_id=dist_id,
                chunks=[{'hash': h, 'size': version.chunk_size_index[h]}
                        for h in sorted(version.chunks)],
                url_provider=url_provider,
                state=state,
                cancel_event=cancel_event,
                progress_cb=_download_progress,
            )
        except ChunkDownloadError as e:
            logger.error(
                f"sync_pull: chunk download failed for distribution {dist_id} "
                f"({roost_id}/{version_id}): {e}"
            )
            state.set_distribution_state(dist_id, 'failed', error=str(e))
            _report_target_state(
                service, site_id, roost_id, version_id, 'failed',
                error=f"chunk download: {e}",
            )
            _release_chunks(version, dist_id)
            return _failure(f"sync_pull failed: chunk download: {e}")

        if cancel_event.is_set() and dl_result.failed == 0:
            state.set_distribution_state(dist_id, 'cancelled')
            _report_target_state(
                service, site_id, roost_id, version_id, 'cancelled',
            )
            return f"sync_pull cancelled during download (distribution {dist_id})"

        # assemble files atomically.
        state.set_distribution_state(dist_id, 'assembling')
        _report_target_state(
            service, site_id, roost_id, version_id, 'assembling',
            chunks_fetched=dl_result.fetched,
            chunks_dedup=dl_result.already_present,
            files_total=len(version.files),
        )
        try:
            asm_result = assemble_all(
                distribution_id=dist_id,
                files=version.files,
                extract_root=extract_root,
                state=state,
                allowlist=allowlist,
                cancel_event=cancel_event,
            )
        except (AssembleError, DestinationNotAllowedError) as e:
            logger.error(
                f"sync_pull: file assembly failed for distribution {dist_id} "
                f"({roost_id}/{version_id}) into {extract_root!r}: {e}"
            )
            state.set_distribution_state(dist_id, 'failed', error=str(e))
            _report_target_state(
                service, site_id, roost_id, version_id, 'failed',
                error=f"file assembly: {e}",
            )
            _release_chunks(version, dist_id)
            return _failure(f"sync_pull failed: file assembly: {e}")

        if cancel_event.is_set() and asm_result.failed == 0:
            state.set_distribution_state(dist_id, 'cancelled')
            _report_target_state(
                service, site_id, roost_id, version_id, 'cancelled',
            )
            return f"sync_pull cancelled during assembly (distribution {dist_id})"

        state.set_distribution_state(dist_id, 'committed')
        _report_target_state(
            service, site_id, roost_id, version_id, 'committed',
            chunks_fetched=dl_result.fetched,
            chunks_dedup=dl_result.already_present,
            files_assembled=asm_result.assembled,
            files_skipped=asm_result.skipped,
            files_pruned=asm_result.pruned,
        )
        return (
            f"sync_pull complete (distribution {dist_id}): "
            f"fetched {dl_result.fetched} chunks, "
            f"dedup {dl_result.already_present}, "
            f"assembled {asm_result.assembled} files, "
            f"skipped {asm_result.skipped}, "
            f"pruned {asm_result.pruned}"
        )

    finally:
        with _inflight_lock:
            _inflight_cancels.pop(dist_id, None)


def _handle_cancel_sync(cmd_data: dict, cmd_id: str, service: Any) -> str:
    """
    cancel an in-flight sync_pull. the worker checks the cancel_event
    between chunks (and between files in the assembler), so cancellation
    is graceful — current operation completes, no corrupted state.
    """
    site_id = _require_str(cmd_data, 'site_id')
    roost_id = _require_str(cmd_data, 'roost_id')
    version_id = _require_str(cmd_data, 'version_id')

    cancel_key = (site_id, roost_id, version_id)
    with _inflight_lock:
        ev = _setup_cancels.get(cancel_key)
        if ev is not None:
            ev.set()
            return (
                "cancel_sync: cancellation signalled for pending sync "
                f"({site_id}, {roost_id}, {version_id})"
            )

    state = _state_for(service)
    row = state.find_distribution(site_id, roost_id, version_id)
    if row is None:
        return f"cancel_sync: no distribution found for ({site_id}, {roost_id}, {version_id})"
    dist_id = row['id']

    with _inflight_lock:
        ev = _inflight_cancels.get(dist_id)
    if ev is None:
        return f"cancel_sync: distribution {dist_id} is not in-flight (state={row['state']})"
    ev.set()
    return f"cancel_sync: cancellation signalled for distribution {dist_id}"


def _handle_rollback_to_version(cmd_data: dict, cmd_id: str, service: Any) -> str:
    """
    treat rollback as a sync_pull of an older version. agent doesn't need
    special "rollback" logic — the version pointer flip happens server-side
    (web /api/roosts/.../rollback), and the agent simply sees a new
    sync_pull command for the older version id.
    """
    return _handle_sync_pull(cmd_data, cmd_id, service)


# helpers
def _failure(message: str) -> str:
    """
    format a handler failure the way every other owlette command handler
    does: an `Error: ` prefix.

    this is load-bearing, not cosmetic. firebase_client._execute_command
    decides between `_mark_command_completed` and `_mark_command_failed` on
    `result.startswith("Error:")` — a failure string without the prefix is
    written to firestore as status:'completed', which is exactly how a
    refused deploy came to be reported as a successful one.
    """
    return f"Error: {message}"


def _release_chunks(version: Version, dist_id: int) -> None:
    """
    release the cached chunks of a distribution that has just reached a
    TERMINAL failure state.

    a failed distribution is never resumed — a retry arrives as a fresh
    sync_pull that re-downloads whatever the content store lacks — so its
    bytes are pure leak. cancellation deliberately does NOT come through
    here: a cancelled sync resumes from exactly these chunks.

    never raises: the command has already failed and a cleanup problem must
    not mask the real error.
    """
    try:
        deleted, freed = cleanup_chunks(version.chunks)
    except Exception as e:
        logger.warning(
            f"sync_pull: could not release cached chunks for failed "
            f"distribution {dist_id}: {type(e).__name__}: {e}"
        )
        return
    if deleted:
        logger.info(
            f"sync_pull: released {deleted} cached chunk(s) "
            f"({freed / (1024 * 1024):.1f} MiB) from failed distribution {dist_id}"
        )


def _require_str(d: dict, key: str) -> str:
    v = d.get(key)
    if not isinstance(v, str) or not v:
        raise ValueError(f"command payload missing required string field {key!r}")
    return v


def _state_for(service: Any) -> SyncState:
    """
    lazily attach a SyncState to the service so all handlers share one
    connection. the service owns its lifecycle.
    """
    state = getattr(service, '_sync_state', None)
    if state is None:
        state = SyncState()
        service._sync_state = state
    return state


class _NullReader:
    """Fail-open stand-in for the pre-client boot window."""

    def get_site_doc(self, _site_id: str):
        return None


def _firestore_reader_for(service: Any) -> Any:
    """
    Wrap the service's firebase client so `roost_kill_switch.check_enabled` sees
    the minimal `get_site_doc(site_id)` surface. Lazy-cached on the service
    instance; for tests the service is often a plain object that already exposes
    `get_site_doc` directly.

    The site doc arrives through GET /agent/site, not Firestore. Agents cannot
    read `sites/{siteId}` — firestore.rules scopes them to their machine subtree —
    so the server-mediated projection is the only way to see `roostEnabled`.
    """
    reader = getattr(service, '_roost_site_reader', None)
    if reader is not None:
        return reader

    # Tests can quack like a reader themselves.
    if hasattr(service, 'get_site_doc'):
        service._roost_site_reader = service
        return service

    client = getattr(service, 'firebase_client', None)
    if client is None:
        # No client yet (early boot) — a None-returning stub is fail-open.
        # Deliberately NOT memoized: caching it here would pin the kill switch
        # open for the life of the process because the real client attaches a
        # moment later and would never be consulted.
        return _NullReader()

    class _FirebaseSiteReader:
        def __init__(self, fc: Any) -> None:
            self._fc = fc

        def get_site_doc(self, _site_id: str):
            # No try/except. This used to call `self._fc.get_document(...)`, a
            # method FirebaseClient does not have, and swallow the AttributeError
            # into None — which is_enabled_from_doc reads as "enabled" and
            # check_enabled then CACHED, defeating its own documented "read
            # errors are not cached" contract. The kill switch had therefore
            # never been observed by an agent. Letting a real failure propagate
            # restores the uncached fail-open path.
            #
            # The site is implied by the agent's own token claim, so the id
            # argument is unused.
            return self._fc.get_site_metadata()

    reader = _FirebaseSiteReader(client)
    service._roost_site_reader = reader
    return reader


def _allowlist_for(service: Any) -> DestinationAllowlist:
    """
    lazily build a DestinationAllowlist from the agent's config. read from
    config['agent_config']['allowed_extract_roots']; fail-closed if absent.
    """
    allowlist = getattr(service, '_destination_allowlist', None)
    if allowlist is None:
        # Deferred: keeps shared_utils out of module load for test isolation.
        import shared_utils
        config = shared_utils.read_config() or {}
        allowlist = DestinationAllowlist.from_config(config)
        service._destination_allowlist = allowlist
    return allowlist


def _load_prior_version(
    service: Any, site_id: str, roost_id: str, exclude_version_id: str
) -> Optional[Version]:
    """
    find the most recent COMMITTED version for this roost (excluding
    the version we're about to install) and load it from cache. used
    for diffing.
    """
    state = _state_for(service)
    # Only the immediately prior committed distribution is considered; a real
    # lineage walk is a v3 concern.
    with state._lock:  # type: ignore[attr-defined]
        assert state._conn is not None
        cur = state._conn.execute(
            '''SELECT version_id, version_url FROM distributions
               WHERE site_id = ? AND roost_id = ? AND version_id != ?
                 AND state = 'committed'
               ORDER BY updated_at DESC LIMIT 1''',
            (site_id, roost_id, exclude_version_id),
        )
        row = cur.fetchone()
    if row is None:
        return None
    prior_id = row['version_id']
    # The sqlite row's `version_url` came from the original sync_pull command
    # (unsigned or long-expired), so mint fresh — that recovers even after the
    # local version cache has been evicted.
    prior_url = row['version_url']
    fb = getattr(service, 'firebase_client', None)
    if fb is not None and hasattr(fb, 'get_version_download_url'):
        try:
            prior_url = fb.get_version_download_url(roost_id, prior_id)
        except Exception as e:
            logger.warning(
                f"sync_commands: failed to mint fresh url for prior version "
                f"{prior_id}: {type(e).__name__}: {e}; falling back to stored url"
            )
    try:
        return fetch_version(prior_url, expected_version_id=prior_id)
    except VersionError as e:
        # Prior version unfetchable — treat as "no prior" and diff everything.
        logger.warning(
            f"sync_commands: prior version {prior_id} unfetchable: {e}; "
            f"diffing against nothing"
        )
        return None


def _report_target_state(
    service: Any,
    site_id: str,
    roost_id: str,
    version_id: str,
    status: str,
    *,
    error: Optional[str] = None,
    **metrics: Any,
) -> None:
    """
    Write this machine's per-target sync status to:
        sites/{site_id}/roosts/{roost_id}/target_state/{machine_id}

    The `onTargetStateWritten` cloud function reads this to advance the
    canary→fleet rollout state machine, and the web UI reads it to show
    per-target progress on the roost page.

    Never raises — a firestore blip must not take down an otherwise-healthy
    sync. The operator still sees the local SyncState transition in logs
    even if the report itself failed.
    """
    fb = getattr(service, 'firebase_client', None)
    if fb is None or getattr(fb, 'db', None) is None:
        return

    try:
        machine_id = fb.get_machine_id() if hasattr(fb, 'get_machine_id') else None
    except Exception:
        machine_id = None
    if not machine_id:
        # No identity → nothing coherent to write; lower layers already logged.
        return

    payload: Dict[str, Any] = {
        'reportedVersionId': version_id,
        'status': status,
        'updatedAt': SERVER_TIMESTAMP,
    }
    if error:
        # Truncated for doc size; the full error is in the agent log + SyncState.
        payload['error'] = error[:500]
    for k, v in metrics.items():
        if v is not None:
            payload[k] = v

    path = f'sites/{site_id}/roosts/{roost_id}/target_state/{machine_id}'
    try:
        fb.db.set_document(path, payload, merge=True)
    except Exception as e:
        logger.warning(
            f"sync_commands: failed to report target_state "
            f"({status}) for {roost_id}/{version_id}: {type(e).__name__}: {e}"
        )


def _make_chunk_url_provider(service: Any):
    """
    return a BATCH callback that issues fresh signed download urls for
    chunk hashes. signature: `Callable[[list[str]], dict[str, str]]`.
    matches the contract sync_downloader expects (URL_PREFETCH_BATCH_SIZE
    upfront, then single-hash refetches on 403).

    talks to web api `POST /api/chunks/download-urls` using the agent's
    OAuth bearer token via firebase_client.get_chunk_download_urls.

    raises NotImplementedError ONLY if the service has no firebase_client
    (offline/local-only mode); a clear surface for the misconfiguration.
    """
    fb = getattr(service, 'firebase_client', None)
    if fb is None:
        def _no_client(chunk_hashes):
            raise NotImplementedError(
                "chunk url provider unavailable: agent has no firebase_client "
                "(running in local-only mode?). check agent startup logs."
            )
        return _no_client

    def _provider(chunk_hashes):
        if not chunk_hashes:
            return {}
        return fb.get_chunk_download_urls(list(chunk_hashes))
    return _provider
