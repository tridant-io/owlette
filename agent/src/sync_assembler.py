"""
sync_assembler — atomic file reassembly for roost (project distribution v2).

concatenates content-store chunks into `<extract_root>/<version_path>` via a
`<path>.partial` sidecar that is fsynced then `os.replace`d, so a live file is
never partially overwritten.

- destination_allowlist gates EVERY target path before any disk write; empty
  allowlist rejects everything (fail-closed). runs as SYSTEM, so that gate plus
  the sync guard rails are what stop customer-path → SYSTEM-write escalation.
- cancellation is honored between files only — mid-file would leave a
  wrong-sized file on disk.
- assemble-then-prune: a crash between the two leaves a complete superset (old
  files still playable) rather than a tree with files missing.

not here: chunk download (sync_downloader), version fetch (sync_version), HTTP.
"""

from __future__ import annotations

import logging
import os
import threading
from dataclasses import dataclass
from pathlib import Path
from typing import Iterable, List, Optional, Set, Tuple

from destination_allowlist import (
    DestinationAllowlist,
    DestinationNotAllowedError,
    get_interactive_user_ids,
    get_interactive_username,
)
from sync_downloader import chunk_path, _default_content_store
from sync_version import VersionFile
from sync_state import SyncState

logger = logging.getLogger(__name__)

# canonical resolver lives in sync_downloader._default_content_store().
DEFAULT_CONTENT_STORE = _default_content_store()

# small enough to avoid OOM on 50GB files, large enough to keep IO efficient.
_ASSEMBLE_BUFFER_BYTES = 1024 * 1024  # 1 MiB

# windows MAX_PATH. at/above this, win32 APIs need the `\\?\` prefix even with
# LongPathsEnabled set — some of them still cap at 260 without it.
_WINDOWS_MAX_PATH = 260

# The `.partial` sidecar is derived from the target string and never goes
# through allowlist.validate(), and on POSIX the folder around it belongs to
# the kiosk user once _ensure_parent_dir has handed it over — so a symlink
# planted there would redirect a root write. O_NOFOLLOW refuses one; windows
# has no such flag, and O_BINARY there keeps the writes byte-exact.
_PARTIAL_FILE_FLAGS = (
    os.O_WRONLY | os.O_CREAT | os.O_TRUNC
    | getattr(os, 'O_NOFOLLOW', 0) | getattr(os, 'O_BINARY', 0)
)


class AssembleError(Exception):
    """raised when assembly fails for reasons callers must surface."""
    pass


@dataclass
class AssembleResult:
    assembled: int          # files newly written this run
    skipped: int            # files already present + matching (idempotent re-runs)
    failed: int             # files that errored
    cancelled: bool
    pruned: int = 0         # extraneous files deleted by tree reconciliation
    prune_failed: int = 0   # extraneous files that could NOT be deleted


def assemble_all(
    distribution_id: int,
    files: Iterable[VersionFile],
    extract_root: str,
    state: SyncState,
    allowlist: DestinationAllowlist,
    cancel_event: Optional[threading.Event] = None,
    content_store: Optional[str] = None,
    prune: bool = True,
) -> AssembleResult:
    """
    assemble every file from chunks into `extract_root/<file.path>`, then
    reconcile the tree so it matches the version exactly.

    cancel_event is checked between files only (atomic-rename safety).
    prune deletes files under extract_root the version does not declare — what
    makes a rollback a project-level swap, not a per-file overwrite; only runs
    after every file assembled and the run wasn't cancelled.

    raises AssembleError on first failure when cancel_event is None.
    """
    if cancel_event is None:
        cancel_event = threading.Event()
    # recomputed each call so env-var overrides in tests are honored.
    if content_store is None:
        store = Path(_default_content_store())
    else:
        store = Path(os.path.expanduser(content_store))

    # validate extract_root BEFORE any disk work — fail loud, not per-file.
    try:
        resolved_root = allowlist.validate(extract_root)
    except DestinationNotAllowedError as e:
        # log before raising so a refusal is visible in service.log without a
        # firestore round trip (roost hardening finding 2: refusals were silent).
        logger.error(
            f"sync_assembler: distribution {distribution_id} REFUSED — "
            f"extract_root {extract_root!r} is not allowed by "
            f"destination_allowlist: {e}"
        )
        raise AssembleError(
            f"extract_root not allowed by destination_allowlist: {e}"
        ) from e

    files_list = list(files)
    assembled = 0
    skipped = 0
    failed = 0
    # snapshot before a per-file failure sets cancel_event, so "user cancelled"
    # stays distinguishable from "failure short-circuit".
    was_externally_cancelled = cancel_event.is_set()

    for f in files_list:
        if cancel_event.is_set():
            logger.info(
                f"sync_assembler: distribution {distribution_id} cancelled "
                f"after {assembled} assembled, {skipped} skipped"
            )
            break
        try:
            did_write = _assemble_one(
                distribution_id=distribution_id,
                version_file=f,
                extract_root=resolved_root,
                allowlist=allowlist,
                state=state,
                content_store=store,
            )
            if did_write:
                assembled += 1
            else:
                skipped += 1
        except (AssembleError, DestinationNotAllowedError, OSError) as e:
            failed += 1
            logger.error(
                f"sync_assembler: failed to assemble {f.path!r}: {e}",
                exc_info=True,
            )
            state.set_file_state(
                distribution_id, f.path, 'failed',
                error=f"{type(e).__name__}: {e}",
            )
            cancel_event.set()  # short-circuit remaining files

    result = AssembleResult(
        assembled=assembled, skipped=skipped, failed=failed,
        cancelled=was_externally_cancelled and failed == 0,
    )
    logger.info(
        f"sync_assembler: distribution {distribution_id}: "
        f"assembled={assembled} skipped={skipped} failed={failed} "
        f"cancelled={result.cancelled}"
    )
    # failure raises; external cancellation returns via result.cancelled.
    if failed > 0:
        logger.error(
            f"sync_assembler: distribution {distribution_id} FAILED — "
            f"{failed} file(s) could not be assembled into {str(resolved_root)!r}; "
            f"see the per-file errors above"
        )
        raise AssembleError(
            f"distribution {distribution_id}: {failed} file(s) failed to assemble"
        )

    # second half of the atomic project-level swap: anything under extract_root
    # the version doesn't declare belongs to a version we no longer run.
    #
    # ORDER MATTERS — assemble first, prune second. a crash between the two
    # leaves a complete superset; pruning first opens a window with files
    # missing. runs even when assembled == 0: an all-identical rollback still
    # has to lose the extra file the newer version added.
    if prune and not result.cancelled:
        result.pruned, result.prune_failed = _prune_extraneous(
            distribution_id=distribution_id,
            extract_root=resolved_root,
            files=files_list,
            allowlist=allowlist,
            state=state,
        )

    # once renamed into place and committed, chunks are pure duplication (R2 is
    # authoritative; a re-sync or rollback re-downloads) — 100GB saved on a
    # 100GB roost. scoped to THIS version's chunks so a concurrent distribution
    # sharing the store keeps its own. skipped on cancellation (resume needs
    # them) and on all-skip runs.
    if not result.cancelled and assembled > 0:
        chunks_to_cleanup = {
            c.hash
            for f in files_list
            for c in f.chunks
        }
        _cleanup_content_store(store, chunks_to_cleanup)

    return result


def _assemble_one(
    distribution_id: int,
    version_file: VersionFile,
    extract_root: Path,
    allowlist: DestinationAllowlist,
    state: SyncState,
    content_store: Path,
) -> bool:
    """
    assemble ONE file. returns True if a write occurred, False if the file
    was already present + matching (idempotent skip).
    """
    # POSIX version path → local separator; allowlist.validate() covers
    # traversal, ADS and reserved names.
    target_relative = Path(*version_file.path.split('/'))
    target_str = str(extract_root / target_relative)
    resolved_target = allowlist.validate(target_str)

    # ahead of the skip check: the mkdir is a no-op once the folders exist,
    # and a re-sync is how folders an earlier run created before anyone was
    # logged in get handed to the interactive user.
    _ensure_parent_dir(resolved_target, extract_root)

    # idempotent skip on a size match; full-content verification is the
    # periodic scrub's job, not the hot path.
    if resolved_target.exists():
        try:
            if resolved_target.stat().st_size == version_file.size:
                # Re-harden even on skip: a re-sync is how stale DACLs and
                # stale ownership get fixed, and it's one cheap syscall.
                _harden_acl(_long_path(str(resolved_target)))
                _chown_to_interactive_user(_long_path(str(resolved_target)))
                state.set_file_state(distribution_id, version_file.path, 'committed')
                logger.debug(f"sync_assembler: {version_file.path!r} already present + matches size")
                return False
        except OSError:
            pass  # fall through to reassemble

    state.set_file_state(distribution_id, version_file.path, 'assembling')

    # `.partial` sidecar so a crash mid-write leaves the live file untouched.
    partial = resolved_target.with_suffix(resolved_target.suffix + '.partial')

    # open() / os.replace / os.fsync all accept the `\\?\` prefix on windows.
    partial_str = _long_path(str(partial))
    target_str = _long_path(str(resolved_target))

    bytes_written = 0
    try:
        with _open_partial(partial_str) as out:
            for chunk in version_file.chunks:
                src = chunk_path(content_store, chunk.hash)
                if not src.exists():
                    raise AssembleError(
                        f"chunk {chunk.hash[:12]}… missing from content store; "
                        f"download must complete before assembly"
                    )
                with open(src, 'rb') as src_f:
                    while True:
                        buf = src_f.read(_ASSEMBLE_BUFFER_BYTES)
                        if not buf:
                            break
                        out.write(buf)
                        bytes_written += len(buf)
            # fsync before the rename — power loss in between corrupts the file.
            out.flush()
            try:
                os.fsync(out.fileno())
            except OSError as e:
                # fsync fails on some remote filesystems; log + continue.
                logger.warning(
                    f"sync_assembler: fsync failed for {partial}: {e}"
                )

        if bytes_written != version_file.size:
            raise AssembleError(
                f"size mismatch: wrote {bytes_written} bytes, version says {version_file.size}"
            )

        # atomic: MoveFileExW/MOVEFILE_REPLACE_EXISTING on windows, rename(2) elsewhere.
        os.replace(partial_str, target_str)

        # TOCTOU defense: a parent dir could be swapped to a symlink/junction
        # between validate() and the rename. fail-closed — delete and raise.
        _verify_under_root(resolved_target, extract_root)

        # make the rename itself durable; no-op on windows (MoveFileEx handles it).
        if os.name == 'posix':
            dir_fd = os.open(str(resolved_target.parent), os.O_RDONLY)
            try:
                os.fsync(dir_fd)
            finally:
                os.close(dir_fd)

        # best-effort, one per OS: never fail the assembly over an ACL or an
        # owner. _harden_acl is windows-only, the chown POSIX-only.
        _harden_acl(target_str)
        _chown_to_interactive_user(target_str)

        state.set_file_state(distribution_id, version_file.path, 'committed')
        logger.debug(
            f"sync_assembler: {version_file.path!r} assembled "
            f"({bytes_written} bytes, {len(version_file.chunks)} chunks)"
        )
        return True

    except Exception:
        # leave the .partial: sync_state has it 'assembling' and the next run
        # resumes. cleaning up here would lose that.
        raise



def _prune_extraneous(
    distribution_id: int,
    extract_root: Path,
    files: List[VersionFile],
    allowlist: DestinationAllowlist,
    state: SyncState,
) -> Tuple[int, int]:
    """
    delete files this agent wrote for THIS roost that the installing version no
    longer declares, then rmdir what emptied out. returns (deleted, failed).

    candidates come from SyncState provenance, NOT a directory walk: the default
    extract path (`~/Documents/Owlette/`) is shared by every roost that doesn't
    override it, so a "delete what the version doesn't list" walk would have each
    deploy wipe the other roosts and the operator's own files. cost of the safer
    rule: a lost state DB leaves stale files behind — the right way to fail.

    every candidate is re-validated through the allowlist and realpath-checked
    under `extract_root` (same TOCTOU defense as writes); its `.partial` sidecar
    goes too. a failed delete (locked by TouchDesigner, ACL, AV) is logged and
    counted, never raised — the next sync retries.
    """
    dist = state.get_distribution(distribution_id)
    if dist is None:
        logger.warning(
            f"sync_assembler: distribution {distribution_id} has no state row — "
            f"skipping tree reconciliation (cannot establish which files we wrote)"
        )
        return (0, 0)

    keep = {_cmp_key(extract_root / Path(*f.path.split('/'))) for f in files}
    root_cmp = _cmp_key(extract_root)

    # resolve each prior extract_root once so N rows don't pay N resolutions.
    root_matches: dict = {}

    def _same_root(raw_root: Optional[str]) -> bool:
        if not raw_root:
            # no extract_root recorded: can't prove it landed in THIS tree.
            return False
        if raw_root not in root_matches:
            try:
                root_matches[raw_root] = _cmp_key(allowlist.validate(raw_root)) == root_cmp
            except DestinationNotAllowedError:
                root_matches[raw_root] = False
        return root_matches[raw_root]

    candidates: List[Path] = []
    seen: Set[str] = set()
    for row in state.list_roost_written_files(dist['site_id'], dist['roost_id']):
        if not _same_root(row['extract_root']):
            continue
        target = extract_root / Path(*row['path'].split('/'))
        key = _cmp_key(target)
        if key in keep or key in seen:
            continue
        seen.add(key)
        candidates.append(target)

    deleted = 0
    failed = 0
    freed_bytes = 0
    emptied_dirs: Set[Path] = set()

    for path in candidates:
        sidecar = path.with_name(path.name + '.partial')
        if not path.exists() and not sidecar.exists():
            continue
        if not _prune_target_is_safe(path, extract_root, allowlist):
            failed += 1
            continue
        removed_any = False
        for victim in (path, sidecar):
            try:
                if not victim.exists():
                    continue
                try:
                    size = victim.stat().st_size
                except OSError:
                    size = 0
                os.unlink(_long_path(str(victim)))
            except OSError as e:
                failed += 1
                logger.warning(
                    f"sync_assembler: could not prune stale file {str(victim)!r}: {e}"
                )
                continue
            removed_any = True
            freed_bytes += size
            logger.debug(f"sync_assembler: pruned stale file {str(victim)!r}")
        if removed_any:
            deleted += 1
            emptied_dirs.add(path.parent)

    dirs_removed = _remove_empty_dirs(emptied_dirs, extract_root)

    if deleted or failed or dirs_removed:
        logger.info(
            f"sync_assembler: distribution {distribution_id} tree reconciled — "
            f"pruned {deleted} stale file(s) ({freed_bytes / (1024 * 1024):.1f} MiB), "
            f"removed {dirs_removed} empty dir(s); {failed} could not be removed"
        )
    return (deleted, failed)


def _prune_target_is_safe(
    path: Path, extract_root: Path, allowlist: DestinationAllowlist
) -> bool:
    """
    last gate before an unlink: still allowlisted AND still resolving under
    `extract_root`. fail-closed — anything unconfirmed stays on disk.
    """
    try:
        allowlist.validate(str(path))
    except DestinationNotAllowedError as e:
        logger.warning(
            f"sync_assembler: refusing to prune {str(path)!r} — "
            f"allowlist re-validation failed: {e}"
        )
        return False
    try:
        real_path = os.path.realpath(str(path))
        real_root = os.path.realpath(str(extract_root))
    except (OSError, ValueError) as e:
        logger.warning(
            f"sync_assembler: refusing to prune {str(path)!r} — "
            f"realpath failed: {e}"
        )
        return False
    if not _path_is_within(real_path, real_root):
        logger.warning(
            f"sync_assembler: refusing to prune {str(path)!r} — resolves to "
            f"{real_path!r}, outside extract_root {real_root!r}"
        )
        return False
    return True


def _remove_empty_dirs(dirs: Set[Path], extract_root: Path) -> int:
    """
    rmdir each just-emptied directory, then walk upward until a non-empty dir or
    `extract_root` (never removed — the roost keeps its home). rmdir raising on a
    non-empty/in-use dir means "stop here", not an error.
    """
    removed = 0
    root_cmp = _cmp_key(extract_root)
    # deepest-first so a nested chain collapses in one pass
    for d in sorted(dirs, key=lambda p: len(p.parts), reverse=True):
        cur = d
        while _cmp_key(cur) != root_cmp:
            if not _path_is_within(str(cur), str(extract_root)):
                break
            try:
                os.rmdir(_long_path(str(cur)))
            except OSError:
                break
            removed += 1
            cur = cur.parent
    return removed



def cleanup_chunks(
    chunk_hashes: Iterable[str], content_store: Optional[str] = None
) -> Tuple[int, int]:
    """
    release a distribution's chunks from the local content store; returns
    (deleted, bytes_freed).

    also called on the TERMINAL FAILURE path — a 'failed' distribution is never
    resumed (a retry is a fresh command), so its bytes are pure leak. NEVER call
    on cancellation: a cancelled distribution resumes from exactly these chunks.
    """
    store = (
        Path(_default_content_store()) if content_store is None
        else Path(os.path.expanduser(content_store))
    )
    return _cleanup_content_store(store, set(chunk_hashes))


def _cleanup_content_store(
    content_store: Path, chunks_to_cleanup: Set[str]
) -> Tuple[int, int]:
    """
    best-effort delete of each chunk blob and its `.partial` sidecar; a failed
    delete warns but never fails the sync. returns (deleted, bytes_freed).

    shard dirs and the store root are deliberately left — the next sync reuses
    the same structure and empty dirs cost an inode.

    only call on SUCCESSFUL assembly or terminal failure; deleting chunks a
    distribution could still resume from forces a re-download.
    """
    deleted = 0
    total_bytes = 0
    failed = 0
    for chunk_hash in chunks_to_cleanup:
        base = chunk_path(content_store, chunk_hash)
        for path in (base, base.with_name(base.name + '.partial')):
            try:
                # stat before unlink to report freed bytes; the exists() guard
                # covers dedup hits and missing sidecars.
                if path.exists():
                    try:
                        total_bytes += path.stat().st_size
                    except OSError:
                        pass
                    path.unlink()
                    deleted += 1
            except OSError as e:
                # a leftover chunk is wasted disk, not a correctness issue.
                failed += 1
                logger.warning(
                    f"sync_assembler: failed to delete cached chunk "
                    f"{chunk_hash[:12]}… at {path!s}: {e}"
                )
    if deleted or failed:
        freed_mb = total_bytes / (1024 * 1024)
        logger.info(
            f"sync_assembler: cleaned up {deleted} chunk(s) from content store "
            f"({freed_mb:.1f} MiB freed); {failed} delete(s) failed"
        )
    return (deleted, total_bytes)



def _long_path(path: str) -> str:
    """
    prefix a windows path with `\\?\` at/above MAX_PATH (260); no-op on POSIX
    and on short paths.

    `\\?\` requires an absolute, fully-resolved, backslash path — resolution is
    guaranteed by destination_allowlist.validate() upstream. already-prefixed
    paths pass through.
    """
    if os.name != 'nt':
        return path
    if path.startswith('\\\\?\\') or path.startswith('\\\\.\\'):
        return path
    if len(path) < _WINDOWS_MAX_PATH:
        return path
    # `\\?\` works only with backslash paths.
    normalized = path.replace('/', '\\')
    # UNC needs \\?\UNC\server\share\..., not \\?\\\server\share.
    if normalized.startswith('\\\\'):
        return '\\\\?\\UNC\\' + normalized[2:]
    return '\\\\?\\' + normalized


def _open_partial(partial_str: str):
    """The `.partial` sidecar, opened for writing and never through a symlink."""
    return os.fdopen(os.open(partial_str, _PARTIAL_FILE_FLAGS, 0o644), 'wb')


def _ensure_parent_dir(target: 'Path', extract_root: 'Path') -> None:
    """
    mkdir -p on target.parent, then hand every directory below the extract
    root to the interactive user. Path.mkdir rejects the `\\?\` prefix on
    older python, so long paths go through os.makedirs on the prefixed string.

    the POSIX daemon is root, so a project folder it creates is one the kiosk
    app can read from but not write beside (a TouchDesigner Backup/, a lock
    file), where windows inherits the user's ACE from the profile the extract
    root sits in. re-applied on every pass rather than only at creation: a run
    that found nobody logged in leaves root-owned folders behind, and the next
    sync is what repairs them. the extract root is the installer's, and stays
    untouched.
    """
    parent = target.parent
    parent_str = str(parent)
    if os.name == 'nt' and len(parent_str) >= _WINDOWS_MAX_PATH:
        os.makedirs(_long_path(parent_str), exist_ok=True)
    else:
        parent.mkdir(parents=True, exist_ok=True)
    # Nothing to hand over on windows, where ownership is a DACL, or with no
    # console user: skip the ancestor walk rather than pay it per file.
    if get_interactive_user_ids() is None:
        return
    for directory in _dirs_under_root(parent, extract_root):
        _chown_to_interactive_user(str(directory))


def _dirs_under_root(parent: 'Path', extract_root: 'Path') -> List['Path']:
    """`parent` and the directories above it down to `extract_root`, which is
    excluded - outermost first. empty when `parent` is not under the root."""
    chain: List[Path] = []
    current = parent
    while current != extract_root:
        if current.parent == current:
            return []
        chain.append(current)
        current = current.parent
    chain.reverse()
    return chain


def _verify_under_root(resolved_target: 'Path', extract_root: 'Path') -> None:
    """
    confirm `resolved_target` still resolves under `extract_root` after the
    rename, closing the TOCTOU window between allowlist.validate() and
    os.replace() where a parent dir could be swapped to a symlink/junction.

    on mismatch the file is deleted and AssembleError raised — a post-rename
    path outside the root signals active tampering. realpath resolves junctions
    too; comparison is case-folded on windows.
    """
    try:
        real_target = os.path.realpath(str(resolved_target))
        real_root = os.path.realpath(str(extract_root))
    except (OSError, ValueError) as e:
        # fail-closed: can't verify → delete + raise.
        _quarantine_delete(resolved_target)
        raise AssembleError(
            f"post-rename realpath failed for {str(resolved_target)!r}: {e}"
        ) from e

    if not _path_is_within(real_target, real_root):
        _quarantine_delete(resolved_target)
        raise AssembleError(
            f"post-rename integrity check failed: {str(resolved_target)!r} "
            f"resolves to {real_target!r}, outside extract_root {real_root!r}. "
            f"possible symlink/junction tampering — file quarantined."
        )


def _path_is_within(real_target: str, real_root: str) -> bool:
    """
    True when the already-realpath-resolved `real_target` sits under `real_root`;
    case-folded on windows. the separator is appended to both sides so `/foo/bar`
    does not match a root of `/foo/ba`, while `real_root` still matches itself.
    """
    if os.name == 'nt':
        target_cmp = real_target.casefold()
        root_cmp = real_root.casefold()
    else:
        target_cmp = real_target
        root_cmp = real_root
    root_with_sep = root_cmp.rstrip(os.sep) + os.sep
    return (target_cmp + os.sep).startswith(root_with_sep)


def _cmp_key(path: Path) -> str:
    """
    same-file comparison key: case-folded on windows so `Assets/Logo.png` and
    `assets/logo.png` are one entry, exact elsewhere.
    """
    s = str(path)
    return s.casefold() if os.name == 'nt' else s


def _quarantine_delete(path: 'Path') -> None:
    """
    best-effort delete of a file whose post-rename location is suspect; errors
    are logged only, since the caller is about to raise anyway.
    """
    try:
        p = path if isinstance(path, Path) else Path(str(path))
        if p.exists():
            p.unlink()
    except OSError as e:
        logger.error(
            f"sync_assembler: failed to quarantine-delete {str(path)!r}: {e}. "
            f"MANUAL CLEANUP REQUIRED."
        )


def _harden_acl(path_str: str) -> None:
    """
    set explicit DACL: SYSTEM (full) + Administrators (full) + the interactive
    operator (modify, if detectable), inheritance stripped. windows-only,
    best-effort — failure warns and never raises.

    inherited defaults on a multi-user kiosk would let any local user read or
    swap assembled .toe files. the explicit operator ACE is required because UAC
    hands non-elevated processes a filtered token with the Admins SID stripped,
    so admins-group membership alone yields ACCESS_DENIED from the desktop.

    win32security is deferred-imported so pywin32-less test envs can load this
    module; ImportError skips silently.
    """
    if os.name != 'nt':
        return
    try:
        import win32security as ws
        import ntsecuritycon as ntcon
    except ImportError:
        # pywin32 not installed (non-windows test env) — skip.
        return
    try:
        # fresh exclusive DACL — everyone not listed is implicitly denied.
        dacl = ws.ACL()
        system_sid, _, _ = ws.LookupAccountName('', 'SYSTEM')
        admins_sid, _, _ = ws.LookupAccountName('', 'Administrators')
        dacl.AddAccessAllowedAce(ws.ACL_REVISION, ntcon.GENERIC_ALL, system_sid)
        dacl.AddAccessAllowedAce(ws.ACL_REVISION, ntcon.GENERIC_ALL, admins_sid)

        # Best-effort: an unresolvable username just drops the user ACE.
        username = get_interactive_username()
        if username:
            try:
                user_sid, _, _ = ws.LookupAccountName('', username)
                # Windows "Modify": excludes WRITE_DAC/WRITE_OWNER so the
                # operator can't undo the hardening.
                MODIFY = (
                    ntcon.FILE_GENERIC_READ
                    | ntcon.FILE_GENERIC_WRITE
                    | ntcon.FILE_GENERIC_EXECUTE
                    | ntcon.DELETE
                )
                dacl.AddAccessAllowedAce(ws.ACL_REVISION, MODIFY, user_sid)
            except Exception as e:
                # LookupAccountName fails on detached/renamed accounts.
                logger.warning(
                    f"sync_assembler: couldn't add operator {username!r} to DACL "
                    f"for {path_str!r}: {e}"
                )

        sd = ws.GetFileSecurity(path_str, ws.DACL_SECURITY_INFORMATION)
        # args: present=True, dacl, defaulted=False
        sd.SetSecurityDescriptorDacl(1, dacl, 0)
        # strip inheritance. prefer the pywin32 constant: a literal 0x80000000
        # overflows a signed C long on python 3.9 + 32-bit pywin32.
        protected_dacl = getattr(ws, 'PROTECTED_DACL_SECURITY_INFORMATION', None)
        if protected_dacl is None:
            protected_dacl = int(0x80000000)
        ws.SetFileSecurity(
            path_str,
            ws.DACL_SECURITY_INFORMATION | protected_dacl,
            sd,
        )
    except Exception as e:
        logger.warning(f"sync_assembler: ACL hardening failed for {path_str!r}: {e}")


def _chown_to_interactive_user(path_str: str) -> None:
    """
    give an extracted file to the user at the machine. POSIX-only, best-effort —
    failure warns and never raises.

    the daemon runs as root, so an assembled file is root-owned and the kiosk
    account the customer's app runs as cannot open it. windows says the same
    thing as a DACL in `_harden_acl`, and `get_interactive_user_ids` is None
    there.
    """
    ids = get_interactive_user_ids()
    if ids is None:
        return
    uid, gid = ids
    try:
        # follow_symlinks=False: roost created this path itself, so a link
        # sitting at it is tampering by whoever owns the folder, never a real
        # case. NotImplementedError is a platform without lchown - still not a
        # reason to fail an assembly.
        os.chown(path_str, uid, gid, follow_symlinks=False)
    except (OSError, NotImplementedError) as e:
        logger.warning(
            f"sync_assembler: could not give {path_str!r} to uid {uid}: {e}"
        )
