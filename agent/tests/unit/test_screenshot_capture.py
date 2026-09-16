"""
Unit tests for `screenshot_capture` — the agent-side capture →
signed-URL upload → finalize pipeline.

The runtime depends on:
  * the host having `mss` available in the active user's session
    interpreter (real screen capture)
  * a callable `user_session_executor` injected by the service that
    runs Python code via CreateProcessAsUser

In test we substitute the executor with a fake that mimics the
`OwletteService.execute_in_user_session` contract, and we monkey-patch
`requests.post` / `requests.put` so no real network calls happen.
"""

from __future__ import annotations

import os
import tempfile
from unittest.mock import MagicMock, patch

import pytest


# helpers


def _make_executor_result(output_dir: str, payload_bytes: bytes, filename: str = 'screenshot.png'):
    """Stand in for OwletteService.execute_in_user_session — writes
    `payload_bytes` into <output_dir>/<filename> and returns the dict
    contract the real executor produces (outputDir + files + stdout).

    The user-session capture now writes only raw PNG (compression moved
    service-side), so the default filename is screenshot.png."""
    os.makedirs(output_dir, exist_ok=True)
    with open(os.path.join(output_dir, filename), 'wb') as f:
        f.write(payload_bytes)
    return {
        'outputDir': output_dir,
        'files': [filename],
        'stdout': f'monitors=2 size={len(payload_bytes)}\n',
        'stderr': '',
        'exitCode': 0,
        'durationMs': 42,
    }


# user-session capture (returns raw PNG; no compression here)


def test_capture_in_user_session_reads_png_from_output_dir(tmp_path):
    from screenshot_capture import capture_in_user_session

    output_dir = str(tmp_path / 'capture')
    payload = b'\x89PNG\r\n' + b'\x00' * 8192  # PNG signature + filler

    def fake_executor(job_type, code, **kwargs):
        assert job_type == 'python'
        assert kwargs.get('trusted') is True  # screenshot must be trusted
        assert 'import mss' in code
        # capture code must NOT do PIL/JPEG work in the user session —
        # that's service-side now.
        assert 'PIL' not in code
        return _make_executor_result(output_dir, payload, 'screenshot.png')

    png_bytes, monitors = capture_in_user_session(fake_executor, monitor=0)
    assert png_bytes == payload
    assert monitors == 2
    # Output dir should be cleaned up so successive captures don't accumulate.
    assert not os.path.exists(output_dir)


def test_capture_in_user_session_surfaces_executor_error():
    from screenshot_capture import capture_in_user_session, ScreenshotCaptureError

    def fake_executor(*_a, **_kw):
        return {'error': 'no interactive session available', 'outputDir': '/tmp/x'}

    with pytest.raises(ScreenshotCaptureError, match='capture: user-session'):
        capture_in_user_session(fake_executor, monitor=0)


def test_capture_in_user_session_missing_output_dir():
    from screenshot_capture import capture_in_user_session, ScreenshotCaptureError

    def fake_executor(*_a, **_kw):
        return {'files': ['screenshot.png']}  # no outputDir

    with pytest.raises(ScreenshotCaptureError, match="missing 'outputDir'"):
        capture_in_user_session(fake_executor, monitor=0)


def test_capture_in_user_session_no_screenshot_file(tmp_path):
    from screenshot_capture import capture_in_user_session, ScreenshotCaptureError

    def fake_executor(*_a, **_kw):
        return {
            'outputDir': str(tmp_path),
            'files': ['other.txt'],
            'stderr': 'mss is not installed',
        }

    with pytest.raises(ScreenshotCaptureError, match='no screenshot file'):
        capture_in_user_session(fake_executor, monitor=0)


# service-side JPEG compression


def test_compress_to_jpeg_produces_jpeg_from_real_png():
    """With Pillow available (service interpreter bundles it), a real PNG
    compresses to a JPEG body + image/jpeg content-type."""
    from screenshot_capture import _compress_to_jpeg

    PIL = pytest.importorskip('PIL')  # service env has Pillow; skip if not
    from PIL import Image
    import io

    # Build a tiny real PNG so PIL can actually open it.
    buf = io.BytesIO()
    Image.new('RGB', (64, 48), (10, 20, 30)).save(buf, format='PNG')
    png_bytes = buf.getvalue()

    out_bytes, content_type = _compress_to_jpeg(png_bytes)
    assert content_type == 'image/jpeg'
    assert out_bytes[:3] == b'\xff\xd8\xff'  # JPEG SOI marker


def test_compress_to_jpeg_falls_back_to_png_without_pillow(monkeypatch):
    """If Pillow can't import in the service interpreter, return the raw
    PNG + image/png rather than hard-failing the capture."""
    import builtins
    from screenshot_capture import _compress_to_jpeg

    real_import = builtins.__import__

    def blocked_import(name, *args, **kwargs):
        if name == 'PIL' or name.startswith('PIL.'):
            raise ImportError('Pillow not installed')
        return real_import(name, *args, **kwargs)

    monkeypatch.setattr(builtins, '__import__', blocked_import)

    png = b'\x89PNG\r\n' + b'\x00' * 128
    out_bytes, content_type = _compress_to_jpeg(png)
    assert out_bytes == png
    assert content_type == 'image/png'


# upload retry behavior


def test_upload_to_signed_url_succeeds_on_first_attempt():
    from screenshot_capture import upload_to_signed_url

    mock_resp = MagicMock(status_code=200)
    sleep_calls: list[float] = []

    with patch('screenshot_capture.requests.put', return_value=mock_resp) as mock_put:
        upload_to_signed_url(
            'https://signed.example/write',
            b'\xff\xd8\xff',
            sleep_fn=sleep_calls.append,
        )
        assert mock_put.call_count == 1
        assert sleep_calls == []


def test_upload_to_signed_url_retries_on_5xx():
    from screenshot_capture import upload_to_signed_url

    responses = [
        MagicMock(status_code=503, text='busy'),
        MagicMock(status_code=502, text='bad gateway'),
        MagicMock(status_code=200),
    ]
    sleep_calls: list[float] = []

    with patch('screenshot_capture.requests.put', side_effect=responses) as mock_put:
        upload_to_signed_url(
            'https://signed.example/write',
            b'\xff\xd8\xff',
            backoff_s=0.1,
            sleep_fn=sleep_calls.append,
        )
        assert mock_put.call_count == 3
        # Two backoff sleeps between three attempts: 0.1 * 2^0 and 0.1 * 2^1.
        assert sleep_calls == pytest.approx([0.1, 0.2])


def test_upload_to_signed_url_fails_fast_on_4xx():
    from screenshot_capture import upload_to_signed_url, ScreenshotCaptureError

    mock_resp = MagicMock(status_code=403, text='signature mismatch')
    sleep_calls: list[float] = []

    with patch('screenshot_capture.requests.put', return_value=mock_resp) as mock_put:
        with pytest.raises(ScreenshotCaptureError, match='signed-url rejected'):
            upload_to_signed_url(
                'https://signed.example/write',
                b'\xff\xd8\xff',
                sleep_fn=sleep_calls.append,
            )
        assert mock_put.call_count == 1
        assert sleep_calls == []


def test_upload_to_signed_url_exhausts_retries_then_raises():
    from screenshot_capture import upload_to_signed_url, ScreenshotCaptureError

    mock_resp = MagicMock(status_code=503, text='busy')
    sleep_calls: list[float] = []

    with patch('screenshot_capture.requests.put', return_value=mock_resp):
        with pytest.raises(ScreenshotCaptureError, match='failed after 3 attempts'):
            upload_to_signed_url(
                'https://signed.example/write',
                b'\xff\xd8\xff',
                backoff_s=0.0,
                sleep_fn=sleep_calls.append,
            )
        assert len(sleep_calls) == 2


# upload-url request envelope parsing


def test_request_upload_url_parses_envelope():
    from screenshot_capture import request_upload_url

    fake_resp = MagicMock(status_code=200)
    fake_resp.json.return_value = {
        'ok': True,
        'data': {
            'uploadUrl': 'https://signed.example/write/abc',
            'storagePath': 'screenshots/site_a/mach_x/1700000000000-aabb.jpg',
            'contentType': 'image/jpeg',
            'expiresAt': '2026-04-25T12:00:00Z',
        },
    }
    with patch('screenshot_capture.requests.post', return_value=fake_resp) as mock_post:
        out = request_upload_url(
            'https://owlette.app/api',
            'site_a',
            'mach_x',
            'fake-token',
            content_type='image/jpeg',
        )
        assert out['uploadUrl'] == 'https://signed.example/write/abc'
        assert out['storagePath'].startswith('screenshots/site_a/mach_x/')

        called_kwargs = mock_post.call_args.kwargs
        assert called_kwargs['headers']['Authorization'] == 'Bearer fake-token'
        assert called_kwargs['json'] == {'contentType': 'image/jpeg'}


def test_request_upload_url_raises_on_error_status():
    from screenshot_capture import request_upload_url, ScreenshotCaptureError

    fake_resp = MagicMock(status_code=403, text='forbidden')
    with patch('screenshot_capture.requests.post', return_value=fake_resp):
        with pytest.raises(ScreenshotCaptureError, match='request failed: 403'):
            request_upload_url(
                'https://owlette.app/api', 'site_a', 'mach_x', 'fake-token'
            )


# finalize


def test_finalize_screenshot_posts_storage_path_and_size():
    from screenshot_capture import finalize_screenshot

    fake_resp = MagicMock(status_code=200)
    fake_resp.json.return_value = {
        'ok': True,
        'data': {
            'url': 'https://storage.googleapis.com/owlette-dev.firebasestorage.app/screenshots/site_a/mach_x/1700-aa.jpg?t=1700',
            'storagePath': 'screenshots/site_a/mach_x/1700-aa.jpg',
            'sizeKB': 1182,
            'monitor': 0,
        },
    }
    with patch('screenshot_capture.requests.post', return_value=fake_resp) as mock_post:
        out = finalize_screenshot(
            api_base='https://owlette.app/api',
            site_id='site_a',
            machine_id='mach_x',
            bearer_token='fake-token',
            storage_path='screenshots/site_a/mach_x/1700-aa.jpg',
            size_kb=1182,
            monitor=0,
        )
        assert out['url'].startswith('https://storage.googleapis.com/')

        called_kwargs = mock_post.call_args.kwargs
        assert called_kwargs['headers']['Authorization'] == 'Bearer fake-token'
        assert called_kwargs['json'] == {
            'storagePath': 'screenshots/site_a/mach_x/1700-aa.jpg',
            'sizeKB': 1182,
            'monitor': 0,
            'contentType': 'image/jpeg',
        }


def test_finalize_screenshot_raises_on_error_status():
    from screenshot_capture import finalize_screenshot, ScreenshotCaptureError

    fake_resp = MagicMock(status_code=500, text='internal error')
    with patch('screenshot_capture.requests.post', return_value=fake_resp):
        with pytest.raises(ScreenshotCaptureError, match='finalize: request failed: 500'):
            finalize_screenshot(
                api_base='https://owlette.app/api',
                site_id='site_a',
                machine_id='mach_x',
                bearer_token='fake-token',
                storage_path='screenshots/site_a/mach_x/x.jpg',
                size_kb=100,
                monitor=0,
            )


def test_finalize_screenshot_raises_on_missing_url():
    from screenshot_capture import finalize_screenshot, ScreenshotCaptureError

    fake_resp = MagicMock(status_code=200)
    fake_resp.json.return_value = {'ok': True, 'data': {}}  # url missing
    with patch('screenshot_capture.requests.post', return_value=fake_resp):
        with pytest.raises(ScreenshotCaptureError, match='response missing data.url'):
            finalize_screenshot(
                api_base='https://owlette.app/api',
                site_id='site_a',
                machine_id='mach_x',
                bearer_token='fake-token',
                storage_path='screenshots/site_a/mach_x/x.jpg',
                size_kb=100,
                monitor=0,
            )


# full pipeline


def test_capture_and_upload_full_pipeline_happy_path(tmp_path):
    """capture raw PNG (user session) → compress to JPEG (service) →
    upload-url → PUT → finalize."""
    from screenshot_capture import capture_and_upload

    output_dir = str(tmp_path / 'capture-run')
    raw_png = b'\x89PNG\r\n' + b'\x00' * 4096

    def fake_executor(*_a, **_kw):
        return _make_executor_result(output_dir, raw_png, 'screenshot.png')

    jpeg_bytes = b'\xff\xd8\xff' + b'\x11' * 2048

    with patch(
        'screenshot_capture._compress_to_jpeg',
        return_value=(jpeg_bytes, 'image/jpeg'),
    ) as mock_compress, patch(
        'screenshot_capture.request_upload_url',
        return_value={
            'uploadUrl': 'https://signed.example/write',
            'storagePath': 'screenshots/site_a/mach_x/1700-aabb.jpg',
            'contentType': 'image/jpeg',
            'expiresAt': '2026-04-25T12:00:00Z',
        },
    ) as mock_request_url, patch(
        'screenshot_capture.upload_to_signed_url'
    ) as mock_upload, patch(
        'screenshot_capture.finalize_screenshot',
        return_value={
            'url': 'https://storage.googleapis.com/bucket/screenshots/site_a/mach_x/1700-aabb.jpg?t=1700',
            'storagePath': 'screenshots/site_a/mach_x/1700-aabb.jpg',
            'sizeKB': 2,
            'monitor': 1,
        },
    ) as mock_finalize:
        result = capture_and_upload(
            user_session_executor=fake_executor,
            api_base='https://owlette.app/api',
            site_id='site_a',
            machine_id='mach_x',
            bearer_token='tok',
            monitor=1,
        )

    assert result['storage_path'] == 'screenshots/site_a/mach_x/1700-aabb.jpg'
    assert result['url'].startswith('https://storage.googleapis.com/')
    assert result['monitor'] == 1
    assert result['monitor_count'] == 2

    # Compression got the raw PNG the user session produced.
    assert mock_compress.call_args.args[0] == raw_png
    # Content type flows compress → upload-url → upload → finalize as image/jpeg,
    # and the UPLOADED bytes are the compressed JPEG, not the raw PNG.
    assert mock_request_url.call_args.kwargs['content_type'] == 'image/jpeg'
    upload_kwargs = mock_upload.call_args.kwargs
    assert upload_kwargs['upload_url'] == 'https://signed.example/write'
    assert upload_kwargs['image_bytes'] == jpeg_bytes
    assert upload_kwargs['content_type'] == 'image/jpeg'
    assert mock_finalize.call_args.kwargs['storage_path'] == 'screenshots/site_a/mach_x/1700-aabb.jpg'
    assert mock_finalize.call_args.kwargs['monitor'] == 1
    assert mock_finalize.call_args.kwargs['content_type'] == 'image/jpeg'


def test_capture_and_upload_returns_image_bytes_only_when_asked(tmp_path):
    """The bytes exist for the local Cortex IPC consumer; every other caller
    json-dumps this envelope, so they must not appear by default."""
    from screenshot_capture import capture_and_upload

    output_dir = str(tmp_path / 'capture-run')
    jpeg_bytes = b'\xff\xd8\xff' + b'\x22' * 512

    def fake_executor(*_a, **_kw):
        return _make_executor_result(output_dir, b'\x89PNG\r\n', 'screenshot.png')

    def run(**kwargs):
        with patch(
            'screenshot_capture._compress_to_jpeg',
            return_value=(jpeg_bytes, 'image/jpeg'),
        ), patch(
            'screenshot_capture.request_upload_url',
            return_value={'uploadUrl': 'https://signed.example/write',
                          'storagePath': 'p.jpg'},
        ), patch(
            'screenshot_capture.upload_to_signed_url'
        ), patch(
            'screenshot_capture.finalize_screenshot',
            return_value={'url': 'https://cdn.example/p.jpg'},
        ):
            return capture_and_upload(
                user_session_executor=fake_executor,
                api_base='https://owlette.app/api',
                site_id='site_a',
                machine_id='mach_x',
                bearer_token='tok',
                **kwargs,
            )

    assert 'image_bytes' not in run()
    assert run(include_image_bytes=True)['image_bytes'] == jpeg_bytes


def test_capture_and_upload_applies_the_callers_budget(tmp_path):
    """A caller on the monitor loop bounds its own worst case: the capture
    timeout, the retry count, the per-request timeout and the image budget all
    have to reach the steps that spend the time. The three round-trips are what
    the crash caller's total is made of — miss one and its 38s budget is 53s."""
    from screenshot_capture import capture_and_upload

    output_dir = str(tmp_path / 'capture-run')

    def fake_executor(*_a, **kw):
        fake_executor.timeout = kw.get('timeout')
        return _make_executor_result(output_dir, b'\x89PNG\r\n', 'screenshot.png')

    with patch(
        'screenshot_capture._compress_to_jpeg',
        return_value=(b'\xff\xd8\xff', 'image/jpeg'),
    ) as mock_compress, patch(
        'screenshot_capture.request_upload_url',
        return_value={'uploadUrl': 'https://signed.example/write',
                      'storagePath': 'p.jpg'},
    ) as mock_issue, patch(
        'screenshot_capture.upload_to_signed_url'
    ) as mock_upload, patch(
        'screenshot_capture.finalize_screenshot',
        return_value={'url': 'https://cdn.example/p.jpg'},
    ) as mock_finalize:
        capture_and_upload(
            user_session_executor=fake_executor,
            api_base='https://owlette.app/api',
            site_id='site_a',
            machine_id='mach_x',
            bearer_token='tok',
            max_width=1920,
            quality=60,
            capture_timeout_s=8,
            request_timeout_s=10,
            max_upload_attempts=1,
        )

    assert fake_executor.timeout == 8
    assert mock_compress.call_args.args[1:] == (1920, 60)
    assert mock_upload.call_args.kwargs['max_attempts'] == 1
    assert mock_issue.call_args.kwargs['timeout_s'] == 10
    assert mock_upload.call_args.kwargs['timeout_s'] == 10
    assert mock_finalize.call_args.kwargs['timeout_s'] == 10


def test_capture_and_upload_keeps_the_default_request_timeouts(tmp_path):
    """Unset, each round-trip keeps its own default — the on-demand path runs on
    a worker and should not inherit the crash path's tighter budget."""
    from screenshot_capture import (
        capture_and_upload, FINALIZE_TIMEOUT_S, UPLOAD_TIMEOUT_S,
        UPLOAD_URL_TIMEOUT_S,
    )

    output_dir = str(tmp_path / 'capture-run')

    def fake_executor(*_a, **_kw):
        return _make_executor_result(output_dir, b'\x89PNG\r\n', 'screenshot.png')

    with patch(
        'screenshot_capture._compress_to_jpeg',
        return_value=(b'\xff\xd8\xff', 'image/jpeg'),
    ), patch(
        'screenshot_capture.request_upload_url',
        return_value={'uploadUrl': 'https://signed.example/write',
                      'storagePath': 'p.jpg'},
    ) as mock_issue, patch(
        'screenshot_capture.upload_to_signed_url'
    ) as mock_upload, patch(
        'screenshot_capture.finalize_screenshot',
        return_value={'url': 'https://cdn.example/p.jpg'},
    ) as mock_finalize:
        capture_and_upload(
            user_session_executor=fake_executor,
            api_base='https://owlette.app/api',
            site_id='site_a',
            machine_id='mach_x',
            bearer_token='tok',
        )

    assert mock_issue.call_args.kwargs['timeout_s'] == UPLOAD_URL_TIMEOUT_S
    assert mock_upload.call_args.kwargs['timeout_s'] == UPLOAD_TIMEOUT_S
    assert mock_finalize.call_args.kwargs['timeout_s'] == FINALIZE_TIMEOUT_S


def test_capture_and_upload_propagates_executor_error(tmp_path):
    """If the user-session capture step fails, capture_and_upload raises
    ScreenshotCaptureError before any network call is attempted."""
    from screenshot_capture import capture_and_upload, ScreenshotCaptureError

    def broken_executor(*_a, **_kw):
        return {'error': 'no interactive session', 'outputDir': str(tmp_path)}

    with patch('screenshot_capture.request_upload_url') as mock_request_url, \
         patch('screenshot_capture.upload_to_signed_url') as mock_upload, \
         patch('screenshot_capture.finalize_screenshot') as mock_finalize:
        with pytest.raises(ScreenshotCaptureError, match='no interactive session'):
            capture_and_upload(
                user_session_executor=broken_executor,
                api_base='https://owlette.app/api',
                site_id='site_a',
                machine_id='mach_x',
                bearer_token='tok',
                monitor=0,
            )
        # No network calls — capture failed before any upload step.
        mock_request_url.assert_not_called()
        mock_upload.assert_not_called()
        mock_finalize.assert_not_called()
