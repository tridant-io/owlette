"""
screenshot_capture — agent-side flow for the `capture_screenshot` command.

Pipeline: capture_in_user_session → _compress_to_jpeg → request_upload_url
→ upload_to_signed_url → finalize_screenshot.

Two placement constraints drive the design:
  * The grab has to happen where the user's screen is, which is never where
    the daemon runs: on Windows the service is LocalSystem in Session 0, where
    mss grabs a blank ~2 KB display. Getting it there is per-OS work and
    belongs to `osadapter.capture_screen` — a CreateProcessAsUser round-trip
    on Windows, a job for the resident desktop app on macOS and Linux.
  * JPEG compression happens DAEMON-side, not in that user session: the
    interpreter the capture runs in frequently can't import PIL, which
    silently degraded uploads to uncapped multi-MB PNGs.

Finalize is what writes `machine.lastScreenshot` (the field ScreenshotDialog
listens to), appends the history doc, and prunes to the newest 20.

Every network/schema failure raises ScreenshotCaptureError tagged with the step;
other exceptions bubble to command_router. Runs on `_slow_command_worker` — the
IPC + network round-trips are unbounded and would stall the main loop.
"""

from __future__ import annotations

import errno
import logging
import os
import shutil
import stat
import time
from typing import Any, Callable, Optional

import requests

import osadapter

logger = logging.getLogger(__name__)


UPLOAD_URL_PATH_TMPL = "/sites/{site_id}/machines/{machine_id}/screenshots/upload-url"
FINALIZE_PATH_TMPL = "/sites/{site_id}/machines/{machine_id}/screenshots/finalize"

DEFAULT_CONTENT_TYPE = "image/jpeg"
SCREENSHOT_FILENAME_PNG = "screenshot.png"

UPLOAD_URL_TIMEOUT_S = 15
UPLOAD_TIMEOUT_S = 30
FINALIZE_TIMEOUT_S = 15
MAX_UPLOAD_ATTEMPTS = 3
INITIAL_BACKOFF_S = 1.0
CAPTURE_TIMEOUT_S = 20

MAX_IMAGE_WIDTH_PX = 7680
JPEG_QUALITY = 72

# The capture's output directory belongs to whoever ran the grab — the desktop
# app's own user on POSIX, where the job seam is group-writable by design — so
# the PNG is read off a descriptor on the entry itself: a link planted there
# must not take the root daemon's read out of the seam, and a fifo must not
# stall the monitor loop the crash screenshot captures on. Windows has neither
# flag; the session directory's DACL is the boundary there, and O_BINARY keeps
# the read byte-exact.
_CAPTURE_READ_FLAGS = (
    os.O_RDONLY | getattr(os, 'O_NOFOLLOW', 0)
    | getattr(os, 'O_NONBLOCK', 0) | getattr(os, 'O_BINARY', 0)
)
_CAPTURE_READ_BLOCK_BYTES = 1024 * 1024


# `OwletteService.execute_in_user_session`, typed loosely so tests can pass a
# plain function. Only the Windows arm of `osadapter.capture_screen` calls it,
# and the result shape it answers with is the operation's on every platform:
#     {outputDir: str (required), error: str|None (presence means failure),
#      files: list[str], stdout/stderr/exitCode/durationMs}
UserSessionExecutor = Callable[..., dict]


class ScreenshotCaptureError(RuntimeError):
    """capture/upload/finalize failure; message is tagged with the step."""



def _compress_to_jpeg(
    png_bytes: bytes,
    max_width: int = MAX_IMAGE_WIDTH_PX,
    quality: int = JPEG_QUALITY,
) -> tuple[bytes, str]:
    """
    Compress the raw PNG to JPEG service-side (Pillow ships with the service);
    returns (bytes, content_type). Falls back to the untouched PNG if PIL is
    missing — an oversized upload beats a failed capture.
    """
    try:
        import io
        from PIL import Image
    except ImportError:
        logger.warning(
            "screenshot: Pillow unavailable in service interpreter — "
            "uploading raw PNG (no size cap)"
        )
        return png_bytes, 'image/png'

    img = Image.open(io.BytesIO(png_bytes))
    if img.width > max_width:
        ratio = max_width / img.width
        img = img.resize(
            (max_width, int(img.height * ratio)),
            Image.LANCZOS,
        )
    if img.mode != 'RGB':
        img = img.convert('RGB')
    buf = io.BytesIO()
    img.save(buf, format='JPEG', quality=quality, optimize=True)
    return buf.getvalue(), 'image/jpeg'


def capture_in_user_session(
    executor: UserSessionExecutor,
    monitor: int = 0,
    timeout_s: int = CAPTURE_TIMEOUT_S,
) -> tuple[bytes, int]:
    """
    Capture where the user can see it → (raw_png_bytes, monitor_count),
    cleaning up the output dir. Raises ScreenshotCaptureError on failure,
    timeout, or missing output file.
    """
    result = osadapter.capture_screen(monitor, executor=executor, timeout_s=timeout_s)
    if not isinstance(result, dict):
        raise ScreenshotCaptureError(
            f"capture: user-session executor returned non-dict {type(result).__name__}"
        )

    output_dir = result.get('outputDir')
    err = result.get('error')
    if err:
        raise ScreenshotCaptureError(
            f"capture: user-session execution failed: {err}"
        )
    if not output_dir or not isinstance(output_dir, str):
        raise ScreenshotCaptureError(
            "capture: executor result missing 'outputDir'"
        )

    files = result.get('files') or []
    image_path = os.path.join(output_dir, SCREENSHOT_FILENAME_PNG)
    try:
        if SCREENSHOT_FILENAME_PNG not in files:
            stderr = result.get('stderr') or ''
            raise ScreenshotCaptureError(
                f"capture: no screenshot file in user-session output "
                f"(files={files!r}); stderr: {stderr[:200]}"
            )
        try:
            png_bytes = _read_capture_file(image_path)
        except OSError as e:
            raise ScreenshotCaptureError(
                f"capture: failed to read user-session output {image_path}: {e}"
            ) from e
    finally:
        # The directory is the caller's to remove whether or not there was
        # anything in it to read; orphans add up over thousands of captures.
        shutil.rmtree(output_dir, ignore_errors=True)

    monitors_count = _parse_monitor_count(result.get('stdout') or '')
    return png_bytes, monitors_count


def _read_capture_file(path: str) -> bytes:
    """The PNG the capture wrote, read off a descriptor on the file itself."""
    fd = os.open(path, _CAPTURE_READ_FLAGS)
    try:
        if not stat.S_ISREG(os.fstat(fd).st_mode):
            raise OSError(errno.EINVAL, 'not a regular file', path)
        return b''.join(iter(lambda: os.read(fd, _CAPTURE_READ_BLOCK_BYTES), b''))
    finally:
        os.close(fd)


def _parse_monitor_count(stdout: str) -> int:
    """`monitors=N` from stdout; 1 if absent — the capture itself still worked."""
    for line in stdout.splitlines():
        for token in line.split():
            if token.startswith('monitors='):
                try:
                    return int(token.split('=', 1)[1])
                except (ValueError, IndexError):
                    continue
    return 1



def request_upload_url(
    api_base: str,
    site_id: str,
    machine_id: str,
    bearer_token: str,
    content_type: str = DEFAULT_CONTENT_TYPE,
    timeout_s: int = UPLOAD_URL_TIMEOUT_S,
) -> dict:
    """
    POST .../screenshots/upload-url → `{uploadUrl, storagePath, contentType,
    expiresAt}`. Raises ScreenshotCaptureError on non-2xx or malformed body.
    """
    url = api_base.rstrip('/') + UPLOAD_URL_PATH_TMPL.format(
        site_id=site_id, machine_id=machine_id
    )
    headers = {
        'Authorization': f'Bearer {bearer_token}',
        'Content-Type': 'application/json',
    }
    body = {'contentType': content_type}

    try:
        resp = requests.post(url, json=body, headers=headers, timeout=timeout_s)
    except requests.RequestException as e:
        raise ScreenshotCaptureError(f"upload-url: network error: {e}") from e

    if resp.status_code >= 400:
        raise ScreenshotCaptureError(
            f"upload-url: request failed: {resp.status_code} {resp.text[:200]}"
        )

    try:
        payload = resp.json()
    except ValueError as e:
        raise ScreenshotCaptureError(
            f"upload-url: response is not json: {resp.text[:200]}"
        ) from e

    data = payload.get('data') if isinstance(payload, dict) else None
    if not isinstance(data, dict):
        raise ScreenshotCaptureError(
            f"upload-url: response missing data envelope: {payload!r}"
        )
    if 'uploadUrl' not in data or 'storagePath' not in data:
        raise ScreenshotCaptureError(
            f"upload-url: response missing required fields: {data!r}"
        )
    return data


def upload_to_signed_url(
    upload_url: str,
    image_bytes: bytes,
    content_type: str = DEFAULT_CONTENT_TYPE,
    max_attempts: int = MAX_UPLOAD_ATTEMPTS,
    backoff_s: float = INITIAL_BACKOFF_S,
    sleep_fn: Any = time.sleep,
    timeout_s: int = UPLOAD_TIMEOUT_S,
) -> None:
    """
    PUT to the signed URL, retrying 5xx + network errors with backoff. 4xx
    fails fast — a bad signature or expired url never recovers on retry.
    """
    last_exc: Optional[Exception] = None
    for attempt in range(1, max_attempts + 1):
        try:
            resp = requests.put(
                upload_url,
                data=image_bytes,
                headers={'Content-Type': content_type},
                timeout=timeout_s,
            )
            if 200 <= resp.status_code < 300:
                return
            if 400 <= resp.status_code < 500:
                raise ScreenshotCaptureError(
                    f"upload: signed-url rejected: {resp.status_code} {resp.text[:200]}"
                )
            last_exc = ScreenshotCaptureError(
                f"upload: signed-url 5xx: {resp.status_code} {resp.text[:200]}"
            )
        except requests.RequestException as e:
            last_exc = e

        if attempt < max_attempts:
            sleep_fn(backoff_s * (2 ** (attempt - 1)))

    raise ScreenshotCaptureError(
        f"upload: failed after {max_attempts} attempts: {last_exc}"
    )



def finalize_screenshot(
    api_base: str,
    site_id: str,
    machine_id: str,
    bearer_token: str,
    storage_path: str,
    size_kb: int,
    monitor: int,
    content_type: str = DEFAULT_CONTENT_TYPE,
    timeout_s: int = FINALIZE_TIMEOUT_S,
) -> dict:
    """
    POST .../screenshots/finalize. Web flips the object to public-read, writes
    `machine.lastScreenshot`, appends history, returns the public URL.
    """
    url = api_base.rstrip('/') + FINALIZE_PATH_TMPL.format(
        site_id=site_id, machine_id=machine_id
    )
    headers = {
        'Authorization': f'Bearer {bearer_token}',
        'Content-Type': 'application/json',
    }
    body = {
        'storagePath': storage_path,
        'sizeKB': int(size_kb),
        'monitor': int(monitor),
        'contentType': content_type,
    }

    try:
        resp = requests.post(url, json=body, headers=headers, timeout=timeout_s)
    except requests.RequestException as e:
        raise ScreenshotCaptureError(f"finalize: network error: {e}") from e

    if resp.status_code >= 400:
        raise ScreenshotCaptureError(
            f"finalize: request failed: {resp.status_code} {resp.text[:200]}"
        )

    try:
        payload = resp.json()
    except ValueError as e:
        raise ScreenshotCaptureError(
            f"finalize: response is not json: {resp.text[:200]}"
        ) from e

    data = payload.get('data') if isinstance(payload, dict) else None
    if not isinstance(data, dict) or 'url' not in data:
        raise ScreenshotCaptureError(
            f"finalize: response missing data.url: {payload!r}"
        )
    return data



def capture_and_upload(
    user_session_executor: UserSessionExecutor,
    api_base: str,
    site_id: str,
    machine_id: str,
    bearer_token: str,
    monitor: Any = 0,
    max_width: int = MAX_IMAGE_WIDTH_PX,
    quality: int = JPEG_QUALITY,
    capture_timeout_s: int = CAPTURE_TIMEOUT_S,
    max_upload_attempts: int = MAX_UPLOAD_ATTEMPTS,
    request_timeout_s: Optional[int] = None,
    include_image_bytes: bool = False,
) -> dict:
    """
    Full pipeline; returns the command's `result` envelope:
    `{storage_path, url, size_kb, monitor, monitor_count}` — `url` is the
    public read URL finalize also wrote to machine.lastScreenshot.

    The budget arguments default to the on-demand settings; a caller that runs
    somewhere it cannot afford them — the crash path is inline on the monitor
    loop, live view repeats every few seconds — passes its own.
    `request_timeout_s` caps each of the three round-trips, which is the only
    way to bound the pipeline's total wall time: left unset they keep their
    individual defaults and the worst case is 15 + 30 + 15 seconds.

    `include_image_bytes` adds the compressed `image_bytes` to the envelope for
    the local Cortex IPC consumer, which renders them as an MCP image block.
    Leave it off for anything that ends up in a Firestore document.

    Failures raise ScreenshotCaptureError tagged with the step
    (capture / upload-url / upload / finalize).
    """
    monitor_int = int(monitor) if isinstance(monitor, (int, float, bool)) else 0
    # bool subclasses int; True must not select monitor 1.
    if isinstance(monitor, bool):
        monitor_int = 0

    png_bytes, monitor_count = capture_in_user_session(
        user_session_executor, monitor_int, timeout_s=capture_timeout_s
    )

    image_bytes, content_type = _compress_to_jpeg(png_bytes, max_width, quality)
    size_kb = max(1, round(len(image_bytes) / 1024))

    # Content-type is pinned at signing time to whatever we actually produced.
    issued = request_upload_url(
        api_base=api_base,
        site_id=site_id,
        machine_id=machine_id,
        bearer_token=bearer_token,
        content_type=content_type,
        timeout_s=request_timeout_s or UPLOAD_URL_TIMEOUT_S,
    )

    upload_to_signed_url(
        upload_url=issued['uploadUrl'],
        image_bytes=image_bytes,
        content_type=content_type,
        max_attempts=max_upload_attempts,
        timeout_s=request_timeout_s or UPLOAD_TIMEOUT_S,
    )

    finalized = finalize_screenshot(
        api_base=api_base,
        site_id=site_id,
        machine_id=machine_id,
        bearer_token=bearer_token,
        storage_path=issued['storagePath'],
        size_kb=size_kb,
        monitor=monitor_int,
        content_type=content_type,
        timeout_s=request_timeout_s or FINALIZE_TIMEOUT_S,
    )

    envelope = {
        'storage_path': issued['storagePath'],
        'url': finalized['url'],
        'size_kb': size_kb,
        'monitor': monitor_int,
        'monitor_count': monitor_count,
    }
    if include_image_bytes:
        envelope['image_bytes'] = image_bytes
    return envelope
