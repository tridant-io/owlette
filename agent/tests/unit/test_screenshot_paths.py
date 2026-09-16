"""Characterization tests for the THREE screenshot callers in owlette_service.py.

All three now run the one pipeline in ``screenshot_capture`` through
``OwletteService._run_capture_pipeline``:

  * ``OwletteService._handle_capture_screenshot``  (on-demand / hoot / Cortex IPC)
  * ``OwletteService._capture_crash_screenshot``   (best-effort, on crash)
  * ``OwletteService._live_view_loop``             (periodic live view)

What they no longer share is what a failure MEANS, and that is what this file
pins: the same ``ScreenshotCaptureError`` becomes an error dict at the on-demand
site, ``None`` at the crash site, and a DEBUG line plus a live loop at the
live-view site. The capture, upload and finalize steps themselves are covered by
test_screenshot_capture.py -- none of them are re-tested here.

Mocking follows the house style: the real unbound method is bound onto a
``SimpleNamespace`` via the descriptor protocol
(``OwletteService.<method>.__get__(fake, OwletteService)``) so the production
body runs without constructing the Windows service, and owlette_service is
imported lazily inside helpers (matching test_cortex_process_command.py) so
module collection does not eagerly initialize the cryptography rust bindings.
"""

from __future__ import annotations

import base64
import logging
import time

from types import SimpleNamespace
from unittest.mock import MagicMock, patch

import pytest


# The em dash the source uses in user-facing / log strings. Spelled as an
# escape so this test file stays pure ASCII.
EMDASH = '\u2014'


# ---------------------------------------------------------------------------
# helpers
# ---------------------------------------------------------------------------


_UNSET = object()


def _upload_envelope(url='https://cdn/x.jpg', size_kb=3, monitor=0,
                     monitor_count=1):
    """What screenshot_capture.capture_and_upload returns on success."""
    return {
        'storage_path': 'sites/s1/machines/m1/screenshots/2026.jpg',
        'url': url,
        'size_kb': size_kb,
        'monitor': monitor,
        'monitor_count': monitor_count,
    }


def _make_service(pipeline_result=None, pipeline_error=None,
                  firebase_client=_UNSET):
    """A minimal double carrying only the attributes the three sites read."""
    from owlette_service import OwletteService

    pipeline = MagicMock(return_value=pipeline_result)
    if pipeline_error is not None:
        pipeline.side_effect = pipeline_error

    svc = SimpleNamespace(
        _run_capture_pipeline=pipeline,
        firebase_client=MagicMock() if firebase_client is _UNSET else firebase_client,
        _live_view_active=True,
        _live_view_stop_time=0.0,
    )
    for name in ('_handle_capture_screenshot', '_capture_crash_screenshot',
                 '_live_view_loop'):
        setattr(svc, name, getattr(OwletteService, name).__get__(svc, OwletteService))
    return svc


def _capture_error(message='capture: user-session execution failed: boom'):
    from screenshot_capture import ScreenshotCaptureError
    return ScreenshotCaptureError(message)


def _log_levels(caplog, needle):
    """Level names of every captured record whose message contains `needle`.

    Asserting on this rather than on caplog.text pins the LEVEL too -- these
    three sites deliberately use different levels for the same class of
    failure, and caplog.text alone would not notice a level change.
    """
    return sorted({r.levelname for r in caplog.records if needle in r.getMessage()})


# ---------------------------------------------------------------------------
# the shared pipeline entry point
# ---------------------------------------------------------------------------


def _pipeline_service(firebase_client=_UNSET, token='tok-1'):
    from owlette_service import OwletteService

    if firebase_client is _UNSET:
        firebase_client = SimpleNamespace(
            site_id='site-1',
            machine_id='machine-1',
            auth_manager=SimpleNamespace(
                get_valid_token=MagicMock(return_value=token)),
        )

    svc = SimpleNamespace(
        firebase_client=firebase_client,
        execute_in_user_session=MagicMock(),
    )
    svc._run_capture_pipeline = OwletteService._run_capture_pipeline.__get__(
        svc, OwletteService)
    return svc


class TestRunCapturePipeline:

    def test_passes_the_cloud_identity_and_the_session_executor(self):
        import owlette_service

        svc = _pipeline_service()
        envelope = _upload_envelope()

        with patch.object(owlette_service, 'capture_and_upload',
                          return_value=envelope) as capture, \
             patch.object(owlette_service.shared_utils, 'get_api_base_url',
                          return_value='https://api.example/api'):
            out = svc._run_capture_pipeline(2)

        assert out is envelope
        assert capture.call_args.kwargs == {
            'user_session_executor': svc.execute_in_user_session,
            'api_base': 'https://api.example/api',
            'site_id': 'site-1',
            'machine_id': 'machine-1',
            'bearer_token': 'tok-1',
            'monitor': 2,
            'include_image_bytes': False,
        }

    def test_forwards_the_callers_budget(self):
        """The crash caller runs inline on the monitor loop and the live-view
        caller repeats every few seconds; neither can afford the on-demand
        defaults, so the budget has to reach capture_and_upload."""
        import owlette_service

        svc = _pipeline_service()

        with patch.object(owlette_service, 'capture_and_upload',
                          return_value=_upload_envelope()) as capture, \
             patch.object(owlette_service.shared_utils, 'get_api_base_url',
                          return_value='https://api.example/api'):
            svc._run_capture_pipeline(
                max_width=1920, quality=60, capture_timeout_s=8,
                max_upload_attempts=1)

        kwargs = capture.call_args.kwargs
        assert kwargs['max_width'] == 1920
        assert kwargs['quality'] == 60
        assert kwargs['capture_timeout_s'] == 8
        assert kwargs['max_upload_attempts'] == 1

    def test_defaults_to_the_combined_virtual_screen(self):
        import owlette_service

        svc = _pipeline_service()

        with patch.object(owlette_service, 'capture_and_upload',
                          return_value=_upload_envelope()) as capture, \
             patch.object(owlette_service.shared_utils, 'get_api_base_url',
                          return_value='https://api.example/api'):
            svc._run_capture_pipeline()

        assert capture.call_args.kwargs['monitor'] == 0

    @pytest.mark.parametrize('client', [
        None,
        SimpleNamespace(site_id=None, machine_id='m1', auth_manager=object()),
        SimpleNamespace(site_id='s1', machine_id=None, auth_manager=object()),
        SimpleNamespace(site_id='s1', machine_id='m1', auth_manager=None),
    ])
    def test_an_unusable_cloud_client_never_reaches_the_network(self, client):
        """Capture runs on the crash path, where firebase_client can be absent.
        It has to fail as a ScreenshotCaptureError, not an AttributeError."""
        import owlette_service
        from screenshot_capture import ScreenshotCaptureError

        svc = _pipeline_service(firebase_client=client)

        with patch.object(owlette_service, 'capture_and_upload') as capture:
            with pytest.raises(ScreenshotCaptureError,
                               match='no authenticated cloud client'):
                svc._run_capture_pipeline()

        capture.assert_not_called()

    def test_a_token_refresh_failure_is_tagged_as_a_capture_error(self):
        import owlette_service
        from screenshot_capture import ScreenshotCaptureError

        svc = _pipeline_service()
        svc.firebase_client.auth_manager.get_valid_token.side_effect = RuntimeError('revoked')

        with patch.object(owlette_service, 'capture_and_upload') as capture:
            with pytest.raises(ScreenshotCaptureError, match='valid auth token: revoked'):
                svc._run_capture_pipeline()

        capture.assert_not_called()


# ---------------------------------------------------------------------------
# site 1: _handle_capture_screenshot
# ---------------------------------------------------------------------------


class TestHandleCaptureScreenshot:

    def test_forwards_the_requested_monitor(self):
        svc = _make_service(pipeline_result=_upload_envelope(monitor=2))

        svc._handle_capture_screenshot({'monitor': 2})

        svc._run_capture_pipeline.assert_called_once_with(
            2, include_image_bytes=False)

    def test_default_monitor_is_zero(self):
        svc = _make_service(pipeline_result=_upload_envelope())

        svc._handle_capture_screenshot({})

        svc._run_capture_pipeline.assert_called_once_with(
            0, include_image_bytes=False)

    def test_success_return_shape(self):
        svc = _make_service(
            pipeline_result=_upload_envelope(url='https://cdn/shot.jpg', size_kb=42))

        out = svc._handle_capture_screenshot({'monitor': 0})

        assert out == {
            'message': 'Screenshot captured (all monitors, 42KB) '
                       + EMDASH + ' URL: https://cdn/shot.jpg',
            'url': 'https://cdn/shot.jpg',
            'size_kb': 42,
            'monitor': 0,
        }
        # Nothing asked for image bytes, so nothing here can carry base64 into
        # a Firestore command result (1 MB document limit).
        assert 'base64' not in out

    def test_include_image_returns_the_jpeg_as_base64(self):
        """The Cortex IPC caller renders the bytes as an MCP image block --
        without them the on-machine agent never sees the screen."""
        envelope = _upload_envelope()
        envelope['image_bytes'] = b'\xff\xd8\xffjpeg'
        svc = _make_service(pipeline_result=envelope)

        out = svc._handle_capture_screenshot({'monitor': 0, 'include_image': True})

        svc._run_capture_pipeline.assert_called_once_with(
            0, include_image_bytes=True)
        assert out['base64'] == base64.b64encode(b'\xff\xd8\xffjpeg').decode('ascii')

    def test_monitor_label_and_monitor_come_from_the_pipeline(self):
        """capture_and_upload coerces the monitor; the reported value is its
        answer, not the raw command field."""
        svc = _make_service(pipeline_result=_upload_envelope(monitor=1))

        out = svc._handle_capture_screenshot({'monitor': '1'})

        assert 'monitor 1' in out['message']
        assert out['monitor'] == 1

    def test_writes_firebase_audit_event(self):
        svc = _make_service(pipeline_result=_upload_envelope(size_kb=7))

        svc._handle_capture_screenshot({'monitor': 0})

        svc.firebase_client.log_event.assert_called_once_with(
            action='command_executed',
            level='info',
            details='Screenshot captured (7KB)',
        )

    def test_logs_size_at_info(self, caplog):
        svc = _make_service(pipeline_result=_upload_envelope(size_kb=7))

        with caplog.at_level(logging.DEBUG):
            svc._handle_capture_screenshot({'monitor': 0})

        assert _log_levels(caplog, 'Screenshot captured: 7KB') == ['INFO']

    def test_an_empty_url_leaves_a_bare_message(self):
        svc = _make_service(pipeline_result=_upload_envelope(url=''))

        out = svc._handle_capture_screenshot({'monitor': 0})

        assert out['message'] == 'Screenshot captured (all monitors, 3KB)'
        assert out['url'] == ''

    def test_capture_error_returns_error_dict(self):
        svc = _make_service(pipeline_error=_capture_error(
            'upload-url: request failed: 403 forbidden'))

        out = svc._handle_capture_screenshot({'monitor': 0})

        assert out == {
            'error': 'Screenshot failed: upload-url: request failed: 403 forbidden'}
        svc.firebase_client.log_event.assert_not_called()

    def test_unexpected_exception_is_named_in_the_error_dict(self):
        """An error dict is the contract; the type is what tells a triager this
        was a bug rather than a capture that failed on its own terms."""
        svc = _make_service(pipeline_error=TypeError('not subscriptable'))

        out = svc._handle_capture_screenshot({'monitor': 0})

        assert out == {'error': 'Screenshot failed: TypeError: not subscriptable'}

    def test_firebase_log_failure_turns_a_successful_capture_into_an_error(self):
        """Current behaviour, pinned: the audit write is inside the same try, so
        an upload that reached the dashboard is still reported as a failure."""
        svc = _make_service(pipeline_result=_upload_envelope())
        svc.firebase_client.log_event.side_effect = RuntimeError('offline')

        out = svc._handle_capture_screenshot({'monitor': 0})

        assert out == {'error': 'Screenshot failed: RuntimeError: offline'}


# ---------------------------------------------------------------------------
# site 2: _capture_crash_screenshot
# ---------------------------------------------------------------------------


class TestCaptureCrashScreenshot:

    def test_captures_the_combined_virtual_screen(self):
        svc = _make_service(pipeline_result=_upload_envelope())

        svc._capture_crash_screenshot()

        # Inline on the monitor loop: an 8s capture cap, 10s on each of the
        # three round-trips and one upload attempt hold the worst-case stall to
        # the ~38s of the single-request upload this replaced, and the frame
        # stays the size pipeline B sent.
        svc._run_capture_pipeline.assert_called_once_with(
            max_width=1920, quality=60, capture_timeout_s=8,
            request_timeout_s=10, max_upload_attempts=1)

    def test_returns_url_and_logs_size_on_success(self, caplog):
        svc = _make_service(
            pipeline_result=_upload_envelope(url='https://cdn/crash.jpg', size_kb=3))

        with caplog.at_level(logging.DEBUG):
            out = svc._capture_crash_screenshot()

        assert out == 'https://cdn/crash.jpg'
        assert _log_levels(caplog, 'Crash screenshot captured: 3KB') == ['INFO']

    def test_writes_no_firebase_audit_event(self):
        """The crash path logs process_crash with the url attached; a second
        command_executed row would double-count it."""
        svc = _make_service(pipeline_result=_upload_envelope())

        svc._capture_crash_screenshot()

        svc.firebase_client.log_event.assert_not_called()

    def test_capture_error_returns_none_and_logs_debug(self, caplog):
        svc = _make_service(pipeline_error=_capture_error(
            'capture: no interactive session available'))

        with caplog.at_level(logging.DEBUG):
            out = svc._capture_crash_screenshot()

        assert out is None
        assert _log_levels(caplog, 'Crash screenshot failed: ') == ['DEBUG']

    def test_unexpected_exception_returns_none_and_logs_debug(self, caplog):
        """This runs inline in the monitor loop, just before the relaunch --
        nothing here may propagate."""
        svc = _make_service(pipeline_error=RuntimeError('boom'))

        with caplog.at_level(logging.DEBUG):
            out = svc._capture_crash_screenshot()

        assert out is None
        assert _log_levels(caplog, 'Crash screenshot failed: boom') == ['DEBUG']

    def test_empty_url_yields_none_and_no_size_log(self, caplog):
        svc = _make_service(pipeline_result=_upload_envelope(url=''))

        with caplog.at_level(logging.DEBUG):
            out = svc._capture_crash_screenshot()

        assert out is None
        assert 'Crash screenshot captured' not in caplog.text


# ---------------------------------------------------------------------------
# site 3: _live_view_loop
# ---------------------------------------------------------------------------


def _live_service(pipeline_result=None, pipeline_error=None):
    """A service whose capture ends the loop after a single iteration.

    Clearing _live_view_active inside the call makes both the sleep loop and
    the outer while fall through, so the test never waits on real time.
    """
    svc = _make_service()
    svc._live_view_stop_time = time.time() + 3600

    def _side_effect(*_a, **_kw):
        svc._live_view_active = False
        if pipeline_error is not None:
            raise pipeline_error
        return pipeline_result

    svc._run_capture_pipeline = MagicMock(side_effect=_side_effect)
    return svc


class TestLiveViewLoop:

    def test_captures_once_per_iteration_and_returns_none(self):
        svc = _live_service(pipeline_result=_upload_envelope())

        out = svc._live_view_loop(10)

        assert out is None
        # A frame is cheap to skip and the next is seconds away: one upload
        # attempt and 10s caps on the capture and each round-trip, holding the
        # frame to the ~40s worst case pipeline B had.
        svc._run_capture_pipeline.assert_called_once_with(
            max_width=1920, quality=50, capture_timeout_s=10,
            request_timeout_s=10, max_upload_attempts=1)
        # The upload result is discarded -- no url is surfaced anywhere, and
        # this path writes no audit row.
        svc.firebase_client.log_event.assert_not_called()

    def test_start_and_end_logs(self, caplog):
        svc = _live_service(pipeline_result=_upload_envelope())

        with caplog.at_level(logging.DEBUG):
            svc._live_view_loop(7)

        assert _log_levels(caplog, 'Live view loop started (interval=7s)') == ['INFO']
        assert _log_levels(caplog, 'Live view loop ended') == ['INFO']
        # No per-capture size log on this path.
        assert 'Screenshot captured' not in caplog.text

    def test_finally_clears_flag_and_publishes_inactive(self):
        svc = _live_service(pipeline_result=_upload_envelope())
        svc.firebase_client.is_connected.return_value = True

        svc._live_view_loop(10)

        assert svc._live_view_active is False
        svc.firebase_client.set_machine_flag.assert_called_once_with(
            'liveView', {'active': False})

    def test_finally_skips_flag_when_disconnected(self, caplog):
        svc = _live_service(pipeline_result=_upload_envelope())
        svc.firebase_client.is_connected.return_value = False

        with caplog.at_level(logging.DEBUG):
            svc._live_view_loop(10)

        svc.firebase_client.set_machine_flag.assert_not_called()
        assert 'Live view loop ended' in caplog.text

    def test_capture_error_logs_debug_and_keeps_the_loop_alive(self, caplog):
        """A capture that fails on its own terms is routine here -- a dark
        kiosk with no interactive session fails every single tick."""
        svc = _live_service(pipeline_error=_capture_error(
            'capture: no interactive session available'))

        with caplog.at_level(logging.DEBUG):
            svc._live_view_loop(10)

        assert _log_levels(caplog, 'Live view capture failed: ') == ['DEBUG']
        assert 'Live view loop ended' in caplog.text

    def test_unexpected_exception_logs_warning_and_keeps_the_loop_alive(self, caplog):
        svc = _live_service(pipeline_error=RuntimeError('boom'))

        with caplog.at_level(logging.DEBUG):
            svc._live_view_loop(10)

        assert _log_levels(caplog, 'Live view capture error: boom') == ['WARNING']
        assert 'Live view loop ended' in caplog.text

    def test_outer_exception_logs_error_and_still_runs_finally(self, caplog):
        # A non-comparable stop time makes the while condition raise before
        # the first iteration, exercising the outer handler.
        svc = _live_service(pipeline_result=_upload_envelope())
        svc._live_view_stop_time = object()
        svc.firebase_client.is_connected.return_value = True

        with caplog.at_level(logging.DEBUG):
            svc._live_view_loop(10)

        assert _log_levels(caplog, 'Live view loop crashed: ') == ['ERROR']
        assert svc._live_view_active is False
        svc.firebase_client.set_machine_flag.assert_called_once_with(
            'liveView', {'active': False})
        assert 'Live view loop ended' in caplog.text
        svc._run_capture_pipeline.assert_not_called()

    def test_finally_swallows_flag_publish_failure(self, caplog):
        svc = _live_service(pipeline_result=_upload_envelope())
        svc.firebase_client.is_connected.return_value = True
        svc.firebase_client.set_machine_flag.side_effect = RuntimeError('offline')

        with caplog.at_level(logging.DEBUG):
            svc._live_view_loop(10)  # must not raise

        assert 'Live view loop ended' in caplog.text
