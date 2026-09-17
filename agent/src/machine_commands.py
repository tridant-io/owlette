"""
machine_commands — public-API command handlers that register on the
CommandRouter (api-sprint wave 2 — track 2A).

Wires the `capture_screenshot` command type into the CommandRouter so
the public command-dispatch surface (`POST /api/sites/{siteId}/
machines/{machineId}/commands` with `type=capture_screenshot`) lands on
a handler that runs the full capture → upload → finalize pipeline.

The handler is intentionally thin — all per-step error handling +
return-shape contract live in `screenshot_capture.capture_and_upload`.
We inject `service.execute_in_user_session` as the user-session executor;
where the grab actually runs is `osadapter.capture_screen`'s business —
that executor on Windows, so the grab happens in the active user's
desktop session rather than the LocalSystem Session-0 context the service
runs in, and the resident desktop app's job seam on macOS and Linux.

Return shape contract:
- On success: the handler returns the dict produced by
  capture_and_upload (storage_path / url / size_kb / monitor /
  monitor_count). firebase_client._mark_command_completed stores it
  verbatim under `result: {...}`. The dashboard listens on
  machine.lastScreenshot (which the /finalize endpoint writes
  server-side) — so the command result envelope is for the GET status
  consumer (CLI, SDK, automation), not the dashboard.
- On failure: a string starting with `Error:` so _execute_command
  routes through _mark_command_failed (matches the other handlers in
  this module).
"""

from __future__ import annotations

import logging
from typing import Any

import shared_utils
from command_router import CommandRouter
from screenshot_capture import (
    ScreenshotCaptureError,
    capture_and_upload,
)

logger = logging.getLogger(__name__)


def register_handlers(router: CommandRouter) -> None:
    """
    register all machine-api public handlers on the given CommandRouter.
    called once at OwletteService init time after the router is created.
    """
    router.register("capture_screenshot")(_handle_capture_screenshot)
    logger.info(
        "machine_commands: registered handlers — capture_screenshot"
    )


def _handle_capture_screenshot(cmd_data: dict, cmd_id: str, service: Any):
    """
    capture_screenshot handler.

    Pipeline (see screenshot_capture.capture_and_upload):
      1. capture the screen in the active user's desktop session
      2. request a 5-min signed PUT url from web
      3. PUT bytes directly to GCS
      4. POST /screenshots/finalize — web writes lastScreenshot + history

    returns:
      dict { storage_path, url, size_kb, monitor, monitor_count } on
      success.
      'Error: ...' string on failure → routes through _mark_command_failed.
    """
    monitor = cmd_data.get("monitor", 0)

    fb = getattr(service, "firebase_client", None)
    if fb is None:
        return "Error: firebase_client unavailable; cannot dispatch capture_screenshot"

    auth_manager = getattr(fb, "auth_manager", None)
    if auth_manager is None:
        return "Error: auth_manager unavailable on firebase_client"

    executor = getattr(service, "execute_in_user_session", None)
    if executor is None:
        return (
            "Error: service.execute_in_user_session unavailable; "
            "cannot capture in user-desktop session"
        )

    try:
        token = auth_manager.get_valid_token()
    except Exception as e:
        return f"Error: failed to obtain valid auth token: {e}"

    site_id = getattr(fb, "site_id", None)
    machine_id = getattr(fb, "machine_id", None)
    if not site_id or not machine_id:
        return "Error: site_id or machine_id missing on firebase_client"

    api_base = shared_utils.get_api_base_url()

    try:
        result = capture_and_upload(
            user_session_executor=executor,
            api_base=api_base,
            site_id=site_id,
            machine_id=machine_id,
            bearer_token=token,
            monitor=monitor,
        )
    except ScreenshotCaptureError as e:
        return f"Error: capture_screenshot failed: {e}"
    except Exception as e:
        # surface unexpected failures with the same Error: prefix so they
        # land in completed.{cmd_id}.error rather than completed.result.
        logger.exception("capture_screenshot: unexpected error")
        return f"Error: capture_screenshot raised {type(e).__name__}: {e}"

    try:
        fb.log_event(
            action="command_executed",
            level="info",
            details=(
                f"Screenshot captured "
                f"({result.get('size_kb', 0)}KB, monitor={result.get('monitor')})"
            ),
        )
    except Exception as e:
        # Best-effort audit logging — do not surface to the command result.
        logger.debug(f"capture_screenshot: log_event failed: {e}")

    return result
