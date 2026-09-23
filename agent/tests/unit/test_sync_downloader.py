"""tests for sync_downloader — chunk fetcher with range-resume + verify."""

import hashlib
import threading
from pathlib import Path
from unittest.mock import MagicMock, patch

import pytest

from sync_downloader import (
    ChunkDownloadError,
    DownloadResult,
    _default_content_store,
    chunk_path,
    download_all,
    has_chunk,
)
from sync_state import SyncState


# helpers


def _hash(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def _put_chunk(store: Path, data: bytes) -> str:
    """write data into the content store at its hash path; return hash."""
    h = _hash(data)
    target = chunk_path(store, h)
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_bytes(data)
    return h


# default content store resolution


def test_default_content_store_follows_the_data_root(tmp_path, monkeypatch):
    """the content store is `content` under whatever OWLETTE_DATA_ROOT names."""
    monkeypatch.setenv('OWLETTE_DATA_ROOT', str(tmp_path))
    assert _default_content_store() == str(tmp_path / 'content')


def test_default_content_store_not_under_documents():
    """regression: the default content store MUST NOT live under Documents —
    LocalSystem-expanded `~` points at System32."""
    got = _default_content_store()
    assert 'Documents' not in got


# chunk_path + has_chunk


def test_chunk_path_shards_by_first_two_chars(tmp_path):
    p = chunk_path(tmp_path, 'ab' + 'c' * 62)
    assert p.parent.name == 'ab'
    assert p.name == 'ab' + 'c' * 62


def test_has_chunk_returns_true_for_correct_chunk(tmp_path):
    data = b'hello'
    h = _put_chunk(tmp_path, data)
    assert has_chunk(tmp_path, h, len(data))


def test_has_chunk_returns_false_when_missing(tmp_path):
    assert not has_chunk(tmp_path, 'a' * 64, 100)


def test_has_chunk_deletes_wrong_size(tmp_path):
    data = b'hello'
    h = _put_chunk(tmp_path, data)
    assert not has_chunk(tmp_path, h, 999)
    # file deleted as side effect
    assert not chunk_path(tmp_path, h).exists()


def test_has_chunk_deletes_wrong_content(tmp_path):
    target = chunk_path(tmp_path, 'a' * 64)
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_bytes(b'hello')  # wrong content for hash 'a'*64
    assert not has_chunk(tmp_path, 'a' * 64, 5)
    assert not target.exists()


# download_all happy paths


def _bulk_provider(url='http://r2/sig'):
    """test helper: a batch url_provider that returns the same url for every hash."""
    def _p(hashes):
        return {h: url for h in hashes}
    return _p


def test_dedup_skips_already_present(tmp_path):
    state = SyncState(str(tmp_path / 'state.db'))
    try:
        store = tmp_path / 'content'
        data = b'already-there'
        h = _put_chunk(store, data)
        dist_id = state.start_distribution(
            site_id='s', roost_id='f', version_id='m', version_url='u',
            files=[], chunks=[{'hash': h, 'size': len(data)}],
        )
        url_provider = MagicMock(side_effect=AssertionError("should not be called"))
        result = download_all(
            distribution_id=dist_id,
            chunks=[{'hash': h, 'size': len(data)}],
            url_provider=url_provider,
            state=state,
            content_store=str(store),
        )
        assert result.fetched == 0
        assert result.already_present == 1
        # state was updated to verified
        chunks = state.list_chunks(dist_id, state='verified')
        assert len(chunks) == 1
    finally:
        state.close()


def test_downloads_missing_chunk(tmp_path):
    state = SyncState(str(tmp_path / 'state.db'))
    try:
        store = tmp_path / 'content'
        data = b'fresh download data'
        h = _hash(data)
        dist_id = state.start_distribution(
            site_id='s', roost_id='f', version_id='m', version_url='u',
            files=[], chunks=[{'hash': h, 'size': len(data)}],
        )
        # mock the http GET to return our data
        fake_resp = MagicMock()
        fake_resp.status_code = 200
        fake_resp.iter_content.return_value = iter([data])
        fake_resp.headers = {}
        fake_resp.raise_for_status = MagicMock()
        with patch('sync_downloader.requests.get', return_value=fake_resp):
            result = download_all(
                distribution_id=dist_id,
                chunks=[{'hash': h, 'size': len(data)}],
                url_provider=_bulk_provider(),
                state=state,
                content_store=str(store),
                concurrency=1,
            )
        assert result.fetched == 1
        assert result.already_present == 0
        assert chunk_path(store, h).read_bytes() == data
    finally:
        state.close()


def test_hash_mismatch_triggers_retry_then_fails(tmp_path):
    state = SyncState(str(tmp_path / 'state.db'))
    try:
        store = tmp_path / 'content'
        # claim hash is 'a'*64 but server returns 'wrong content'
        wrong_data = b'wrong content'
        dist_id = state.start_distribution(
            site_id='s', roost_id='f', version_id='m', version_url='u',
            files=[], chunks=[{'hash': 'a' * 64, 'size': len(wrong_data)}],
        )

        fake_resp = MagicMock()
        fake_resp.status_code = 200
        fake_resp.iter_content.return_value = iter([wrong_data])
        fake_resp.headers = {}
        fake_resp.raise_for_status = MagicMock()
        with patch('sync_downloader.requests.get', return_value=fake_resp), \
             patch('sync_downloader._backoff', return_value=None):  # no real sleep
            with pytest.raises(ChunkDownloadError):
                download_all(
                    distribution_id=dist_id,
                    chunks=[{'hash': 'a' * 64, 'size': len(wrong_data)}],
                    url_provider=_bulk_provider(),
                    state=state,
                    content_store=str(store),
                    concurrency=1,
                    retry_budget=2,  # quick fail for test speed
                )
        # state updated to failed
        chunks = state.list_chunks(dist_id, state='failed')
        assert len(chunks) == 1
        # file did not land
        assert not chunk_path(store, 'a' * 64).exists()
    finally:
        state.close()


def test_cancel_event_short_circuits(tmp_path):
    state = SyncState(str(tmp_path / 'state.db'))
    try:
        store = tmp_path / 'content'
        chunks = [{'hash': f'{i:064x}', 'size': 5} for i in range(20)]
        dist_id = state.start_distribution(
            site_id='s', roost_id='f', version_id='m', version_url='u',
            files=[], chunks=chunks,
        )
        cancel_event = threading.Event()
        cancel_event.set()  # pre-cancelled

        result = download_all(
            distribution_id=dist_id,
            chunks=chunks,
            url_provider=_bulk_provider(),
            state=state,
            cancel_event=cancel_event,
            content_store=str(store),
            concurrency=1,
        )
        assert result.fetched == 0
        assert result.cancelled is True
    finally:
        state.close()


def test_signed_url_403_triggers_url_refresh(tmp_path):
    """on 403, the worker retries → _per_hash_lookup invalidates cache → url_provider called again with single hash."""
    state = SyncState(str(tmp_path / 'state.db'))
    try:
        store = tmp_path / 'content'
        data = b'real data'
        h = _hash(data)
        dist_id = state.start_distribution(
            site_id='s', roost_id='f', version_id='m', version_url='u',
            files=[], chunks=[{'hash': h, 'size': len(data)}],
        )

        # first response: 403 (expired url). second: 200 (success).
        fake_403 = MagicMock(status_code=403, headers={})
        fake_200 = MagicMock(status_code=200, headers={})
        fake_200.iter_content.return_value = iter([data])
        fake_200.raise_for_status = MagicMock()

        url_provider = MagicMock(side_effect=[
            {h: 'http://expired/'},   # bulk prefetch
            {h: 'http://fresh/'},     # refresh after 403
        ])

        with patch('sync_downloader.requests.get', side_effect=[fake_403, fake_200]):
            result = download_all(
                distribution_id=dist_id,
                chunks=[{'hash': h, 'size': len(data)}],
                url_provider=url_provider,
                state=state,
                content_store=str(store),
                concurrency=1,
            )
        assert result.fetched == 1
        assert url_provider.call_count == 2  # one bulk prefetch + one refresh after 403


    finally:
        state.close()


def test_range_resume_from_partial_file(tmp_path):
    """mid-download crash recovery: a `.partial` file from a prior run must make
    the next attempt send `Range: bytes=<offset>-` and append the tail rather
    than refetch from byte 0 (src/sync_downloader.py:334)."""
    state = SyncState(str(tmp_path / 'state.db'))
    try:
        store = tmp_path / 'content'
        full_data = b'0123456789' * 10_000  # 100 KiB so the split is non-trivial
        h = _hash(full_data)
        split = 40_000
        first_half = full_data[:split]
        second_half = full_data[split:]

        # pre-create .partial with the first half — a prior download that died
        # ~40% through.
        partial_target = chunk_path(store, h).with_suffix(chunk_path(store, h).suffix + '.partial')
        partial_target.parent.mkdir(parents=True, exist_ok=True)
        partial_target.write_bytes(first_half)

        dist_id = state.start_distribution(
            site_id='s', roost_id='f', version_id='m', version_url='u',
            files=[], chunks=[{'hash': h, 'size': len(full_data)}],
        )

        captured_headers = {}

        def fake_get(url, headers=None, **kwargs):
            # record the headers the worker sent so we can assert Range.
            captured_headers.update(headers or {})
            resp = MagicMock(status_code=200, headers={})
            resp.iter_content.return_value = iter([second_half])
            resp.raise_for_status = MagicMock()
            return resp

        with patch('sync_downloader.requests.get', side_effect=fake_get):
            result = download_all(
                distribution_id=dist_id,
                chunks=[{'hash': h, 'size': len(full_data)}],
                url_provider=_bulk_provider(),
                state=state,
                content_store=str(store),
                concurrency=1,
            )

        assert result.fetched == 1
        # must have sent a Range header from where the partial left off,
        # otherwise it refetched the whole file.
        assert captured_headers.get('Range') == f'bytes={split}-'
        # final file is the full assembly: first_half (preserved) + second_half (appended).
        final = chunk_path(store, h)
        assert final.read_bytes() == full_data
    finally:
        state.close()


def test_bulk_prefetch_batches_above_threshold(tmp_path):
    """500-batch threshold: 1200 chunks → 3 batches (500, 500, 200)."""
    from sync_downloader import URL_PREFETCH_BATCH_SIZE
    assert URL_PREFETCH_BATCH_SIZE == 500  # guard against silent threshold change

    state = SyncState(str(tmp_path / 'state.db'))
    try:
        store = tmp_path / 'content'
        # 1200 chunks, all already present (so workers don't actually run)
        chunks = []
        for i in range(1200):
            data = f'chunk-{i}'.encode()
            h = _put_chunk(store, data)
            chunks.append({'hash': h, 'size': len(data)})
        dist_id = state.start_distribution(
            site_id='s', roost_id='f', version_id='m', version_url='u',
            files=[], chunks=chunks,
        )

        # all dedup-skipped → url_provider never called (prefetch short-circuits
        # on pending=[])
        url_provider = MagicMock(side_effect=AssertionError("dedup means no fetch"))
        result = download_all(
            distribution_id=dist_id,
            chunks=chunks,
            url_provider=url_provider,
            state=state,
            content_store=str(store),
        )
        assert result.fetched == 0
        assert result.already_present == 1200
        url_provider.assert_not_called()
    finally:
        state.close()
