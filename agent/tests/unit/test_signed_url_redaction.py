"""Signed URLs never reach a log line or a stored error through requests'
exception text, which quotes the url, signature and all."""

import logging
from unittest.mock import patch

import pytest
import requests

import installer_utils
import sync_version
from sync_downloader import ChunkDownloadError, download_all
from sync_state import SyncState

SECRET = 'deadbeefsecret'
URL = f'https://r2.example/roost/v1.json?X-Amz-Credential=key%2F20261110&X-Amz-Signature={SECRET}'
CONNECTION_ERROR = requests.exceptions.ConnectionError(
    "HTTPSConnectionPool(host='r2.example', port=443): Max retries exceeded with url: "
    f"/roost/v1.json?X-Amz-Signature={SECRET} (Caused by NewConnectionError('getaddrinfo failed'))"
)
HTTP_ERROR = requests.exceptions.HTTPError(f'403 Client Error: Forbidden for url: {URL}')


def test_redaction_keeps_host_path_and_cause():
    text = installer_utils.redact_query_strings(CONNECTION_ERROR)
    assert SECRET not in text
    assert "host='r2.example'" in text
    assert '/roost/v1.json?<redacted> (Caused by' in text


@pytest.mark.parametrize('error', [CONNECTION_ERROR, HTTP_ERROR], ids=['connection', 'http'])
def test_installer_download_logs_no_signature(error, caplog, tmp_path):
    caplog.set_level(logging.DEBUG)
    with patch('installer_utils.requests.get', side_effect=error), \
         patch('installer_utils.time.sleep'):
        ok, _ = installer_utils.download_file(URL, str(tmp_path / 'setup.exe'), max_retries=2)
    assert ok is False
    assert 'r2.example' in caplog.text
    assert SECRET not in caplog.text


def test_version_fetch_error_carries_no_signature(caplog):
    with patch('sync_version.requests.get', side_effect=CONNECTION_ERROR), \
         patch('sync_version.time.sleep'):
        with pytest.raises(sync_version.VersionError) as raised:
            sync_version._http_fetch(URL)
    assert SECRET not in str(raised.value)
    assert SECRET not in caplog.text


def test_chunk_download_error_carries_no_signature(caplog, tmp_path):
    state = SyncState(str(tmp_path / 'state.db'))
    try:
        chunks = [{'hash': 'a' * 64, 'size': 5}]
        dist_id = state.start_distribution(
            site_id='s', roost_id='f', version_id='m', version_url='u',
            files=[], chunks=chunks,
        )
        with patch('sync_downloader.requests.get', side_effect=CONNECTION_ERROR), \
             patch('sync_downloader._backoff'):
            with pytest.raises(ChunkDownloadError) as raised:
                download_all(
                    distribution_id=dist_id,
                    chunks=chunks,
                    url_provider=lambda hashes: {h: URL for h in hashes},
                    state=state,
                    content_store=str(tmp_path / 'content'),
                    concurrency=1,
                    retry_budget=2,
                )
        [row] = state.list_chunks(dist_id, state='failed')
        assert SECRET not in row['error']
        assert SECRET not in str(raised.value)
        assert SECRET not in caplog.text
    finally:
        state.close()
