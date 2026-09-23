"""
sync_state — crash-safe local state for roost (project distribution v2).

per-roost sync progress in SQLite with WAL journaling, so a crash, power loss
or service restart never loses state; on startup the agent resumes pending ops.

- one DB per install: <data root>/sync-state.db, deliberately outside the
  user's Documents tree so the cache cannot mix with assembled files.
- WAL: atomic writes plus concurrent readers (cortex MCP reads without
  blocking the worker thread).
- rows are written BEFORE a long op and updated, never deleted+reinserted —
  the history is the postmortem trail.
- foreign keys on (cascade delete with a roost); migrations via
  PRAGMA user_version.

SQLite only. download, reassembly and version fetch live in sync_downloader,
sync_assembler and sync_version.
"""

from __future__ import annotations

import logging
import os
import sqlite3
import threading
import time
from contextlib import contextmanager
from pathlib import Path
from typing import Any, Iterable, Iterator, List, Optional, Set

import shared_utils

logger = logging.getLogger(__name__)

# stamped into PRAGMA user_version. _create_schema() builds a FRESH DB at the
# latest shape; existing DBs step forward through _MIGRATIONS. bump this AND add
# a migration on every schema change.
#
# v1 -> v2: roost rename (folder->roost, manifest->version) renamed three
#           distributions columns; see _migrate_1_to_2.
SCHEMA_VERSION = 2

def _default_state_db_path() -> str:
    """
    resolve the default state DB path.

    `sync-state.db` under the agent's data root (on windows
    %PROGRAMDATA%\\Owlette\\sync-state.db).

    rationale: the agent runs as LocalSystem on windows. `~` expands to
    `C:\\Windows\\System32\\config\\systemprofile` under that account, which
    is not an appropriate place for a rebuildable cache — operators can't
    see or clean it up without elevation. the data root is the canonical
    machine-wide application-data location and LocalSystem has write access
    without tricks.
    """
    return shared_utils.get_data_path('sync-state.db')


# in-flight states — the content-store reaper must not touch their blobs.
# 'committed' / 'failed' / 'cancelled' are terminal; no resume from those.
ACTIVE_DISTRIBUTION_STATES = ('pending', 'downloading', 'verifying', 'assembling')

# transition states for chunk + file rows.
# CHUNK: planned -> downloading -> verified -> assembled
# FILE:  planned -> assembling -> assembled -> committed
# distribution rows progress through:
#         pending -> downloading -> verifying -> assembling -> committed
#         (or -> failed | cancelled at any stage)


class SyncStateError(Exception):
    """raised when state-store operations fail in a way callers must handle."""
    pass


def _migrate_1_to_2(conn: sqlite3.Connection) -> None:
    """
    schema v1 -> v2: the roost rename (folder -> roost, manifest -> version).

    pre-rename DBs carry folder_id / manifest_id / manifest_url, so current
    code raises `IndexError: No item with that key` on every row. SQLite 3.25+
    RENAME COLUMN also fixes the constraints and indexes referencing them.

    per-column existence check because interim dev builds stamped
    user_version 1 with the NEW names: renaming a missing column raises
    OperationalError, rolls back the version stamp, and re-crashes on every
    open (TEC-B4A hourly scrub, 2026-08-17).
    """
    columns = {row[1] for row in conn.execute('PRAGMA table_info(distributions)')}
    renames = (
        ('folder_id', 'roost_id'),
        ('manifest_id', 'version_id'),
        ('manifest_url', 'version_url'),
    )
    for old, new in renames:
        if old in columns:
            conn.execute(f'ALTER TABLE distributions RENAME COLUMN {old} TO {new}')


# {target_version: fn(conn)}, applied in order to an existing DB below
# SCHEMA_VERSION. a fresh DB skips these and gets _create_schema().
_MIGRATIONS = {
    2: _migrate_1_to_2,
}


class SyncState:
    """
    crash-safe SQLite-backed state for roost sync operations.

    construction:
        state = SyncState()                    # default path
        state = SyncState('/tmp/test.db')      # explicit path (tests)

    use as a context manager OR call .close() explicitly:
        with SyncState() as state:
            state.start_distribution(...)
    """

    def __init__(self, db_path: Optional[str] = None) -> None:
        if db_path is None:
            # recomputed here so an env override applied after import counts.
            db_path = _default_state_db_path()
        else:
            db_path = os.path.expanduser(db_path)
        self._db_path = Path(db_path)
        self._lock = threading.RLock()
        self._conn: Optional[sqlite3.Connection] = None
        self._open()

    # ─── lifecycle ────────────────────────────────────────────────────

    def _open(self) -> None:
        self._db_path.parent.mkdir(parents=True, exist_ok=True)
        # check_same_thread=False: one connection shared across worker threads,
        # serialized by self._lock. Avoids the SQLite-per-thread gotcha.
        self._conn = sqlite3.connect(
            str(self._db_path),
            check_same_thread=False,
            isolation_level=None,  # autocommit; explicit BEGIN/COMMIT in transactions
        )
        # WAL: writers don't block readers, survives power loss.
        # synchronous=NORMAL: ~3x faster than FULL and good enough for a log
        # that can be replayed against the version if entries are missing.
        self._conn.execute('PRAGMA journal_mode = WAL')
        self._conn.execute('PRAGMA synchronous = NORMAL')
        self._conn.execute('PRAGMA foreign_keys = ON')
        self._conn.row_factory = sqlite3.Row
        self._run_migrations()
        logger.info(f"sync_state opened at {self._db_path}")

    def close(self) -> None:
        with self._lock:
            if self._conn is not None:
                self._conn.close()
                self._conn = None

    def __enter__(self) -> 'SyncState':
        return self

    def __exit__(self, *exc_info: Any) -> None:
        self.close()

    # ─── schema ───────────────────────────────────────────────────────

    def _run_migrations(self) -> None:
        """
        bring the DB up to SCHEMA_VERSION.

        user_version 0 → _create_schema() in one shot; older → each numbered
        _MIGRATIONS step in order, preserving rows; current → no-op.
        """
        assert self._conn is not None
        current = self._conn.execute('PRAGMA user_version').fetchone()[0]
        if current >= SCHEMA_VERSION:
            return
        with self._txn():
            if current == 0:
                self._create_schema()
            else:
                for version in range(current + 1, SCHEMA_VERSION + 1):
                    migrate = _MIGRATIONS.get(version)
                    if migrate is None:
                        raise SyncStateError(
                            f"missing migration to schema v{version} "
                            f"(DB at v{current}, target v{SCHEMA_VERSION})"
                        )
                    migrate(self._conn)
            self._conn.execute(f'PRAGMA user_version = {SCHEMA_VERSION}')
        if current == 0:
            logger.info(f"sync_state schema created (v{SCHEMA_VERSION})")
        else:
            logger.info(f"sync_state migrated schema v{current} -> v{SCHEMA_VERSION}")

    def _create_schema(self) -> None:
        """create the full schema from scratch. single source of truth."""
        assert self._conn is not None
        # distribution = one sync op for a roost. natural key site_id+roost_id;
        # a new version means a new row (immutable history). extract_root +
        # last_scrub_at drive the periodic scrub.
        self._conn.execute('''
            CREATE TABLE distributions (
                id              INTEGER PRIMARY KEY AUTOINCREMENT,
                site_id         TEXT NOT NULL,
                roost_id        TEXT NOT NULL,
                version_id      TEXT NOT NULL,
                version_url     TEXT NOT NULL,
                state           TEXT NOT NULL CHECK (state IN (
                    'pending', 'downloading', 'verifying',
                    'assembling', 'committed', 'failed', 'cancelled'
                )),
                created_at      INTEGER NOT NULL,
                updated_at      INTEGER NOT NULL,
                error           TEXT,
                extract_root    TEXT,
                last_scrub_at   INTEGER,
                UNIQUE (site_id, roost_id, version_id)
            )
        ''')
        # file = a target file reassembled from chunks.
        self._conn.execute('''
            CREATE TABLE files (
                id              INTEGER PRIMARY KEY AUTOINCREMENT,
                distribution_id INTEGER NOT NULL REFERENCES distributions(id) ON DELETE CASCADE,
                path            TEXT NOT NULL,
                size            INTEGER NOT NULL,
                state           TEXT NOT NULL CHECK (state IN (
                    'planned', 'assembling', 'assembled', 'committed', 'failed'
                )),
                error           TEXT,
                UNIQUE (distribution_id, path)
            )
        ''')
        # chunk = one content-addressed blob. a hash may recur across
        # distributions (dedup); this table is per-distribution intent.
        self._conn.execute('''
            CREATE TABLE chunks (
                id              INTEGER PRIMARY KEY AUTOINCREMENT,
                distribution_id INTEGER NOT NULL REFERENCES distributions(id) ON DELETE CASCADE,
                hash            TEXT NOT NULL,
                size            INTEGER NOT NULL,
                state           TEXT NOT NULL CHECK (state IN (
                    'planned', 'downloading', 'verified', 'failed'
                )),
                attempts        INTEGER NOT NULL DEFAULT 0,
                error           TEXT,
                UNIQUE (distribution_id, hash)
            )
        ''')
        self._conn.execute('CREATE INDEX idx_distributions_state ON distributions(state)')
        self._conn.execute('CREATE INDEX idx_distributions_scrub ON distributions(state, last_scrub_at)')
        self._conn.execute('CREATE INDEX idx_chunks_state ON chunks(distribution_id, state)')
        self._conn.execute('CREATE INDEX idx_chunks_hash ON chunks(hash)')
        self._conn.execute('CREATE INDEX idx_files_distribution ON files(distribution_id)')

    # ─── transactions ─────────────────────────────────────────────────

    @contextmanager
    def _txn(self) -> Iterator[sqlite3.Connection]:
        """BEGIN/COMMIT wrapper — every multi-statement write goes through it."""
        assert self._conn is not None
        with self._lock:
            self._conn.execute('BEGIN IMMEDIATE')
            try:
                yield self._conn
                self._conn.execute('COMMIT')
            except Exception:
                self._conn.execute('ROLLBACK')
                raise

    # ─── distributions ────────────────────────────────────────────────

    def start_distribution(
        self,
        site_id: str,
        roost_id: str,
        version_id: str,
        version_url: str,
        files: List[dict],
        chunks: List[dict],
        extract_root: Optional[str] = None,
    ) -> int:
        """
        register a new distribution and its planned files + chunks. atomic.

        files: list of {path, size}
        chunks: list of {hash, size}
        extract_root: where assembled files land on disk. required for the
            periodic scrub to find them later; optional for backward compat
            with v1 callers (those distributions are silently skipped by scrub).

        returns the distribution row id. raises SyncStateError if a row
        already exists for (site_id, roost_id, version_id).
        """
        now = _now()
        try:
            with self._txn() as conn:
                cur = conn.execute(
                    '''INSERT INTO distributions
                       (site_id, roost_id, version_id, version_url,
                        state, created_at, updated_at, extract_root)
                       VALUES (?, ?, ?, ?, 'pending', ?, ?, ?)''',
                    (site_id, roost_id, version_id, version_url, now, now, extract_root),
                )
                dist_id = cur.lastrowid
                if files:
                    conn.executemany(
                        '''INSERT INTO files (distribution_id, path, size, state)
                           VALUES (?, ?, ?, 'planned')''',
                        [(dist_id, f['path'], f['size']) for f in files],
                    )
                if chunks:
                    conn.executemany(
                        '''INSERT INTO chunks (distribution_id, hash, size, state)
                           VALUES (?, ?, ?, 'planned')''',
                        [(dist_id, c['hash'], c['size']) for c in chunks],
                    )
                return dist_id
        except sqlite3.IntegrityError as e:
            raise SyncStateError(
                f"distribution already exists for "
                f"site={site_id!r} roost={roost_id!r} version={version_id!r}: {e}"
            ) from e

    def set_distribution_state(
        self, dist_id: int, state: str, error: Optional[str] = None
    ) -> None:
        """transition a distribution to a new state."""
        with self._txn() as conn:
            conn.execute(
                '''UPDATE distributions
                   SET state = ?, updated_at = ?, error = ?
                   WHERE id = ?''',
                (state, _now(), error, dist_id),
            )

    def get_distribution(self, dist_id: int) -> Optional[sqlite3.Row]:
        """fetch a distribution row by id, or None if not found."""
        with self._lock:
            assert self._conn is not None
            cur = self._conn.execute(
                'SELECT * FROM distributions WHERE id = ?', (dist_id,)
            )
            return cur.fetchone()

    def find_distribution(
        self, site_id: str, roost_id: str, version_id: str
    ) -> Optional[sqlite3.Row]:
        """fetch a distribution by natural key."""
        with self._lock:
            assert self._conn is not None
            cur = self._conn.execute(
                '''SELECT * FROM distributions
                   WHERE site_id = ? AND roost_id = ? AND version_id = ?''',
                (site_id, roost_id, version_id),
            )
            return cur.fetchone()

    def list_pending_distributions(self) -> List[sqlite3.Row]:
        """
        list distributions in non-terminal states. called at agent startup
        to resume in-flight syncs after a crash/restart.
        """
        with self._lock:
            assert self._conn is not None
            placeholders = ', '.join('?' * len(ACTIVE_DISTRIBUTION_STATES))
            cur = self._conn.execute(
                f'''SELECT * FROM distributions
                    WHERE state IN ({placeholders})
                    ORDER BY created_at ASC''',
                ACTIVE_DISTRIBUTION_STATES,
            )
            return list(cur.fetchall())

    def list_scrub_due(self, max_age_seconds: int) -> List[sqlite3.Row]:
        """
        list committed distributions due for scrub: extract_root is set AND
        (last_scrub_at is NULL OR last_scrub_at < now - max_age_seconds).

        ordered oldest-scrub-first so a backlog drains in priority order.
        """
        with self._lock:
            assert self._conn is not None
            cutoff = _now() - max_age_seconds
            cur = self._conn.execute(
                '''SELECT * FROM distributions
                   WHERE state = 'committed'
                     AND extract_root IS NOT NULL
                     AND (last_scrub_at IS NULL OR last_scrub_at < ?)
                   ORDER BY COALESCE(last_scrub_at, 0) ASC''',
                (cutoff,),
            )
            return list(cur.fetchall())

    def mark_scrubbed(self, dist_id: int, scrubbed_at: Optional[int] = None) -> None:
        """update last_scrub_at on a distribution after a successful scrub run."""
        ts = scrubbed_at if scrubbed_at is not None else _now()
        with self._txn() as conn:
            conn.execute(
                'UPDATE distributions SET last_scrub_at = ? WHERE id = ?',
                (ts, dist_id),
            )

    # ─── chunks ───────────────────────────────────────────────────────

    def list_chunks(
        self, dist_id: int, state: Optional[str] = None
    ) -> List[sqlite3.Row]:
        """list chunks for a distribution, optionally filtered by state."""
        with self._lock:
            assert self._conn is not None
            if state is None:
                cur = self._conn.execute(
                    'SELECT * FROM chunks WHERE distribution_id = ?', (dist_id,)
                )
            else:
                cur = self._conn.execute(
                    '''SELECT * FROM chunks
                       WHERE distribution_id = ? AND state = ?''',
                    (dist_id, state),
                )
            return list(cur.fetchall())

    def list_referenced_chunk_hashes(
        self, states: Optional[Iterable[str]] = None
    ) -> Set[str]:
        """
        every chunk hash still referenced by a distribution in one of
        `states` (default: ACTIVE_DISTRIBUTION_STATES).

        this is the "do not delete" set for the content-store reaper
        (sync_scrub.reap_orphan_chunks): a hash in here belongs to a
        distribution that is mid-download or mid-assembly and needs the
        blob to stay put. hashes referenced only by terminal distributions
        are NOT returned — those rows are history, and their chunks were
        either already released by the assembler or leaked by a failure.
        """
        state_list = tuple(states) if states is not None else ACTIVE_DISTRIBUTION_STATES
        if not state_list:
            return set()
        with self._lock:
            assert self._conn is not None
            placeholders = ', '.join('?' * len(state_list))
            cur = self._conn.execute(
                f'''SELECT DISTINCT c.hash
                    FROM chunks c
                    JOIN distributions d ON d.id = c.distribution_id
                    WHERE d.state IN ({placeholders})''',
                state_list,
            )
            return {row['hash'] for row in cur.fetchall()}

    def set_chunk_state(
        self,
        dist_id: int,
        chunk_hash: str,
        state: str,
        error: Optional[str] = None,
        increment_attempts: bool = False,
    ) -> None:
        """transition a chunk's state. optionally increments retry counter."""
        with self._txn() as conn:
            if increment_attempts:
                conn.execute(
                    '''UPDATE chunks
                       SET state = ?, error = ?, attempts = attempts + 1
                       WHERE distribution_id = ? AND hash = ?''',
                    (state, error, dist_id, chunk_hash),
                )
            else:
                conn.execute(
                    '''UPDATE chunks
                       SET state = ?, error = ?
                       WHERE distribution_id = ? AND hash = ?''',
                    (state, error, dist_id, chunk_hash),
                )

    # ─── files ────────────────────────────────────────────────────────

    def list_files(
        self, dist_id: int, state: Optional[str] = None
    ) -> List[sqlite3.Row]:
        """list files for a distribution, optionally filtered by state."""
        with self._lock:
            assert self._conn is not None
            if state is None:
                cur = self._conn.execute(
                    'SELECT * FROM files WHERE distribution_id = ?', (dist_id,)
                )
            else:
                cur = self._conn.execute(
                    '''SELECT * FROM files
                       WHERE distribution_id = ? AND state = ?''',
                    (dist_id, state),
                )
            return list(cur.fetchall())

    def list_roost_written_files(
        self, site_id: str, roost_id: str
    ) -> List[sqlite3.Row]:
        """
        every (path, extract_root) this agent has ever put on disk for a
        roost, across all of its distributions.

        this is the provenance set the assembler's tree reconciliation
        prunes from: a path in here that the version being installed does
        NOT declare is a leftover from an older version and gets deleted.
        deliberately scoped to files WE wrote — the default extract root is
        shared between roosts, so a "delete anything the version doesn't
        list" rule would have one roost eat another's files.

        'planned' rows are excluded: nothing was ever written for them. every
        other state ('assembling' — a `.partial` may exist, 'assembled',
        'committed', 'failed') may have left bytes behind.
        """
        with self._lock:
            assert self._conn is not None
            cur = self._conn.execute(
                '''SELECT DISTINCT f.path AS path, d.extract_root AS extract_root
                   FROM files f
                   JOIN distributions d ON d.id = f.distribution_id
                   WHERE d.site_id = ? AND d.roost_id = ?
                     AND f.state != 'planned' ''',
                (site_id, roost_id),
            )
            return list(cur.fetchall())

    def set_file_state(
        self,
        dist_id: int,
        path: str,
        state: str,
        error: Optional[str] = None,
    ) -> None:
        """transition a file's state."""
        with self._txn() as conn:
            conn.execute(
                '''UPDATE files
                   SET state = ?, error = ?
                   WHERE distribution_id = ? AND path = ?''',
                (state, error, dist_id, path),
            )

    # ─── progress aggregation ─────────────────────────────────────────

    def progress_summary(self, dist_id: int) -> dict:
        """
        return a summary suitable for sending to firestore as the agent's
        reported state. throttled by the caller (see firebase_client).
        """
        with self._lock:
            assert self._conn is not None
            cur = self._conn.execute(
                '''SELECT state, COUNT(*) AS n, COALESCE(SUM(size), 0) AS bytes
                   FROM chunks WHERE distribution_id = ? GROUP BY state''',
                (dist_id,),
            )
            chunk_stats = {row['state']: dict(n=row['n'], bytes=row['bytes'])
                           for row in cur.fetchall()}
            cur = self._conn.execute(
                'SELECT state, COUNT(*) AS n FROM files WHERE distribution_id = ? GROUP BY state',
                (dist_id,),
            )
            file_stats = {row['state']: row['n'] for row in cur.fetchall()}
            return {'chunks': chunk_stats, 'files': file_stats}


def _now() -> int:
    """seconds since epoch as integer (sqlite-friendly)."""
    return int(time.time())
