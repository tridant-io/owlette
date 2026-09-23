"""tests for sync_state — SQLite WAL state machine for roost."""

import sqlite3
import threading
from pathlib import Path

import pytest

from sync_state import SCHEMA_VERSION, SyncState, SyncStateError, _default_state_db_path



def test_default_state_db_path_follows_the_data_root(tmp_path, monkeypatch):
    """the db is `sync-state.db` under whatever OWLETTE_DATA_ROOT names."""
    monkeypatch.setenv('OWLETTE_DATA_ROOT', str(tmp_path))
    assert _default_state_db_path() == str(tmp_path / 'sync-state.db')


def test_default_state_db_path_is_not_under_documents():
    """regression: never `~/Documents/Owlette/...` — under LocalSystem that
    resolves to C:\\Windows\\System32\\config\\systemprofile\\."""
    got = _default_state_db_path()
    assert 'Documents' not in got, (
        f"default state DB path {got!r} must not live under user Documents"
    )



def test_migration_skips_renames_already_applied(tmp_path):
    """regression TEC-B4A (2026-08-17): interim dev builds stamped user_version 1
    on DBs that already had the new column names, so the v1->v2 rename failed
    with "no such column: folder_id", rolled back the stamp, and crashed on every
    open — killing the hourly scrub and content-store reaper forever."""
    db_path = tmp_path / 'state.db'
    seed = SyncState(str(db_path))
    seed.close()
    conn = sqlite3.connect(str(db_path))
    conn.execute('PRAGMA user_version = 1')
    conn.close()

    state = SyncState(str(db_path))
    try:
        stamped = state._conn.execute('PRAGMA user_version').fetchone()[0]
        assert stamped == SCHEMA_VERSION
        columns = {row[1] for row in state._conn.execute('PRAGMA table_info(distributions)')}
        assert 'roost_id' in columns
        assert 'folder_id' not in columns
    finally:
        state.close()


def test_open_creates_db_and_dir(tmp_path):
    db_path = tmp_path / 'subdir' / 'state.db'
    state = SyncState(str(db_path))
    try:
        assert db_path.exists()
        assert db_path.parent.exists()
    finally:
        state.close()


def test_can_open_close_open_again_round_trip(tmp_path):
    db_path = tmp_path / 'state.db'
    s1 = SyncState(str(db_path))
    s1.close()
    s2 = SyncState(str(db_path))
    s2.close()


def test_context_manager_closes_on_exit(tmp_path):
    with SyncState(str(tmp_path / 'state.db')) as state:
        state.start_distribution(
            site_id='s', roost_id='f', version_id='m', version_url='u',
            files=[], chunks=[],
        )
    # Connection is closed after exit, so any op must fail.
    with pytest.raises((sqlite3.ProgrammingError, AssertionError, AttributeError)):
        state.list_pending_distributions()


def test_schema_version_stamped_after_create(tmp_path):
    state = SyncState(str(tmp_path / 'state.db'))
    try:
        cur = state._conn.execute('PRAGMA user_version')
        assert cur.fetchone()[0] == SCHEMA_VERSION
    finally:
        state.close()


def test_wal_mode_enabled(tmp_path):
    state = SyncState(str(tmp_path / 'state.db'))
    try:
        cur = state._conn.execute('PRAGMA journal_mode')
        assert cur.fetchone()[0].lower() == 'wal'
    finally:
        state.close()



def test_fresh_db_uses_current_roost_columns(tmp_path):
    """a fresh DB is created at the latest schema with the renamed columns —
    no legacy folder_id/manifest_* names."""
    with SyncState(str(tmp_path / 'state.db')) as state:
        cols = {r['name'] for r in state._conn.execute('PRAGMA table_info(distributions)')}
        assert {'roost_id', 'version_id', 'version_url'} <= cols
        assert not ({'folder_id', 'manifest_id', 'manifest_url'} & cols)
        assert state._conn.execute('PRAGMA user_version').fetchone()[0] == SCHEMA_VERSION


def _create_v1_distributions_db(path) -> None:
    """build a pre-rename (v1) DB carrying the old distributions column names."""
    conn = sqlite3.connect(str(path))
    try:
        conn.execute('''
            CREATE TABLE distributions (
                id              INTEGER PRIMARY KEY AUTOINCREMENT,
                site_id         TEXT NOT NULL,
                folder_id       TEXT NOT NULL,
                manifest_id     TEXT NOT NULL,
                manifest_url    TEXT NOT NULL,
                state           TEXT NOT NULL,
                created_at      INTEGER NOT NULL,
                updated_at      INTEGER NOT NULL,
                error           TEXT,
                extract_root    TEXT,
                last_scrub_at   INTEGER,
                UNIQUE (site_id, folder_id, manifest_id)
            )
        ''')
        conn.execute(
            'INSERT INTO distributions (site_id, folder_id, manifest_id, manifest_url, '
            'state, created_at, updated_at, extract_root, last_scrub_at) '
            "VALUES ('site_a', 'roost_b', 'ver_c', 'https://x/manifest', "
            "'committed', 1000, 1000, '~/Documents/proj', NULL)"
        )
        conn.execute('PRAGMA user_version = 1')
        conn.commit()
    finally:
        conn.close()


def test_v1_db_migrated_to_v2_renames_columns(tmp_path):
    """an existing pre-rename (v1) DB is migrated in place on open: the three
    drifted columns are renamed and rows are preserved.

    regression for the hourly 'roost scrub failed: No item with that key'
    warning — sqlite3.Row raised IndexError because the code read version_url
    while the on-disk column was still manifest_url.
    """
    db = tmp_path / 'state.db'
    _create_v1_distributions_db(db)

    with SyncState(str(db)) as state:
        assert state._conn.execute('PRAGMA user_version').fetchone()[0] == SCHEMA_VERSION
        cols = {r['name'] for r in state._conn.execute('PRAGMA table_info(distributions)')}
        assert {'roost_id', 'version_id', 'version_url'} <= cols
        assert not ({'folder_id', 'manifest_id', 'manifest_url'} & cols)

        row = state.get_distribution(1)
        assert row is not None
        assert row['site_id'] == 'site_a'
        assert row['roost_id'] == 'roost_b'
        assert row['version_id'] == 'ver_c'
        assert row['version_url'] == 'https://x/manifest'

        # The scrub's query no longer raises.
        due = state.list_scrub_due(max_age_seconds=0)
        assert [r['id'] for r in due] == [1]


def test_migrated_db_is_noop_on_reopen(tmp_path):
    """re-opening an already-migrated DB is a no-op (user_version stays current)."""
    db = tmp_path / 'state.db'
    _create_v1_distributions_db(db)
    with SyncState(str(db)) as state:
        assert state._conn.execute('PRAGMA user_version').fetchone()[0] == SCHEMA_VERSION
    # Re-running the migration would fail — the old columns are gone.
    with SyncState(str(db)) as state:
        assert state._conn.execute('PRAGMA user_version').fetchone()[0] == SCHEMA_VERSION
        assert state.get_distribution(1)['version_url'] == 'https://x/manifest'



def test_start_distribution_creates_row(tmp_path):
    with SyncState(str(tmp_path / 'state.db')) as state:
        dist_id = state.start_distribution(
            site_id='site_a', roost_id='roost_b', version_id='m1',
            version_url='https://r2/m1.json',
            files=[{'path': 'a.toe', 'size': 100}],
            chunks=[{'hash': 'a' * 64, 'size': 100}],
        )
        row = state.get_distribution(dist_id)
        assert row is not None
        assert row['site_id'] == 'site_a'
        assert row['roost_id'] == 'roost_b'
        assert row['version_id'] == 'm1'
        assert row['state'] == 'pending'


def test_start_distribution_duplicate_raises(tmp_path):
    with SyncState(str(tmp_path / 'state.db')) as state:
        state.start_distribution(
            site_id='s', roost_id='f', version_id='m', version_url='u',
            files=[], chunks=[],
        )
        with pytest.raises(SyncStateError, match="already exists"):
            state.start_distribution(
                site_id='s', roost_id='f', version_id='m', version_url='u',
                files=[], chunks=[],
            )


def test_set_distribution_state_updates(tmp_path):
    with SyncState(str(tmp_path / 'state.db')) as state:
        dist_id = state.start_distribution(
            site_id='s', roost_id='f', version_id='m', version_url='u',
            files=[], chunks=[],
        )
        state.set_distribution_state(dist_id, 'downloading')
        row = state.get_distribution(dist_id)
        assert row['state'] == 'downloading'
        state.set_distribution_state(dist_id, 'failed', error='boom')
        row = state.get_distribution(dist_id)
        assert row['state'] == 'failed'
        assert row['error'] == 'boom'


def test_invalid_state_value_rejected(tmp_path):
    with SyncState(str(tmp_path / 'state.db')) as state:
        dist_id = state.start_distribution(
            site_id='s', roost_id='f', version_id='m', version_url='u',
            files=[], chunks=[],
        )
        with pytest.raises(sqlite3.IntegrityError):
            state.set_distribution_state(dist_id, 'made_up_state')


def test_find_distribution_by_natural_key(tmp_path):
    with SyncState(str(tmp_path / 'state.db')) as state:
        state.start_distribution(
            site_id='s', roost_id='f', version_id='m1', version_url='u',
            files=[], chunks=[],
        )
        row = state.find_distribution('s', 'f', 'm1')
        assert row is not None
        assert state.find_distribution('s', 'f', 'never') is None


def test_list_pending_distributions(tmp_path):
    with SyncState(str(tmp_path / 'state.db')) as state:
        d1 = state.start_distribution(site_id='s', roost_id='f1', version_id='m', version_url='u', files=[], chunks=[])
        d2 = state.start_distribution(site_id='s', roost_id='f2', version_id='m', version_url='u', files=[], chunks=[])
        state.set_distribution_state(d2, 'committed')
        pending = state.list_pending_distributions()
        ids = [p['id'] for p in pending]
        assert d1 in ids
        assert d2 not in ids



def test_chunk_state_transitions(tmp_path):
    with SyncState(str(tmp_path / 'state.db')) as state:
        dist_id = state.start_distribution(
            site_id='s', roost_id='f', version_id='m', version_url='u',
            files=[],
            chunks=[{'hash': 'a' * 64, 'size': 100}, {'hash': 'b' * 64, 'size': 200}],
        )
        chunks = state.list_chunks(dist_id)
        assert len(chunks) == 2
        assert all(c['state'] == 'planned' for c in chunks)

        state.set_chunk_state(dist_id, 'a' * 64, 'verified')
        verified = state.list_chunks(dist_id, state='verified')
        assert len(verified) == 1
        assert verified[0]['hash'] == 'a' * 64


def test_chunk_attempts_counter_increments(tmp_path):
    with SyncState(str(tmp_path / 'state.db')) as state:
        dist_id = state.start_distribution(
            site_id='s', roost_id='f', version_id='m', version_url='u',
            files=[], chunks=[{'hash': 'a' * 64, 'size': 100}],
        )
        for _ in range(3):
            state.set_chunk_state(dist_id, 'a' * 64, 'failed', error='retry', increment_attempts=True)
        row = state.list_chunks(dist_id)[0]
        assert row['attempts'] == 3



def test_file_state_transitions(tmp_path):
    with SyncState(str(tmp_path / 'state.db')) as state:
        dist_id = state.start_distribution(
            site_id='s', roost_id='f', version_id='m', version_url='u',
            files=[{'path': 'a.toe', 'size': 100}, {'path': 'b.toe', 'size': 200}],
            chunks=[],
        )
        files = state.list_files(dist_id)
        assert len(files) == 2
        state.set_file_state(dist_id, 'a.toe', 'committed')
        committed = state.list_files(dist_id, state='committed')
        assert len(committed) == 1



def test_progress_summary_counts_by_state(tmp_path):
    with SyncState(str(tmp_path / 'state.db')) as state:
        dist_id = state.start_distribution(
            site_id='s', roost_id='f', version_id='m', version_url='u',
            files=[{'path': 'a.toe', 'size': 100}],
            chunks=[
                {'hash': 'a' * 64, 'size': 100},
                {'hash': 'b' * 64, 'size': 200},
            ],
        )
        state.set_chunk_state(dist_id, 'a' * 64, 'verified')
        summary = state.progress_summary(dist_id)
        assert summary['chunks']['planned']['n'] == 1
        assert summary['chunks']['verified']['n'] == 1
        assert summary['chunks']['verified']['bytes'] == 100
        assert summary['files']['planned'] == 1



def test_concurrent_writes_are_serialized(tmp_path):
    """multiple threads can set chunk state without losing updates."""
    with SyncState(str(tmp_path / 'state.db')) as state:
        chunks = [{'hash': f'{i:064x}', 'size': 100} for i in range(50)]
        dist_id = state.start_distribution(
            site_id='s', roost_id='f', version_id='m', version_url='u',
            files=[], chunks=chunks,
        )

        def mark_verified(idx):
            state.set_chunk_state(dist_id, f'{idx:064x}', 'verified')

        threads = [threading.Thread(target=mark_verified, args=(i,)) for i in range(50)]
        for t in threads:
            t.start()
        for t in threads:
            t.join()

        verified = state.list_chunks(dist_id, state='verified')
        assert len(verified) == 50



def test_crash_safe_state_survives_close_reopen(tmp_path):
    """data persists across process boundary (open/close/open)."""
    db_path = tmp_path / 'state.db'
    with SyncState(str(db_path)) as state:
        dist_id = state.start_distribution(
            site_id='s', roost_id='f', version_id='m', version_url='u',
            files=[{'path': 'a.toe', 'size': 100}],
            chunks=[{'hash': 'a' * 64, 'size': 100}],
        )
        state.set_chunk_state(dist_id, 'a' * 64, 'verified')

    with SyncState(str(db_path)) as state:
        row = state.find_distribution('s', 'f', 'm')
        assert row is not None
        chunks = state.list_chunks(row['id'], state='verified')
        assert len(chunks) == 1
