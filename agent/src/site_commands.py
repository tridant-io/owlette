"""
site_commands — the handler for `site_settings_refresh`.

The dashboard queues this on every online machine of a site when a site setting
the agent mirrors changes (today the keep-screens-awake switch in
`sites/{siteId}/settings/display`). The command carries nothing; it only says
"ask again". The handler re-reads `GET /api/agent/site` through
`FirebaseClient._fetch_site_metadata`, the call the connect path and the 900s
refresh already make, so that projection stays the one place the agent learns
its site's settings. A machine that was offline catches up on reconnect.

The type is on the fast command lane (`firebase_client._FAST_COMMAND_TYPES`), so
the handler hands the round trip to a daemon thread and returns at once.
Single-flight: one fetch at a time, and any requests that land during a fetch
buy exactly one more pass after it, because the running fetch may have read the
server before the change that sent them.
"""

from __future__ import annotations

import logging
import threading
from typing import Any

from command_router import CommandRouter

logger = logging.getLogger(__name__)

_lock = threading.Lock()
_running = False
_again = False


def register_handlers(router: CommandRouter) -> None:
    """
    register the site handler on the given CommandRouter.
    called once at OwletteService init time after the router is created.
    """
    router.register("site_settings_refresh")(handle_site_settings_refresh)
    logger.info("site_commands: registered handler — site_settings_refresh")


def handle_site_settings_refresh(cmd_data: dict, cmd_id: str, service: Any) -> str:
    """start a re-read of the site projection on its own thread. returns immediately."""
    global _running, _again
    client = getattr(service, 'firebase_client', None)
    if client is None:
        return "Error: firebase client unavailable; cannot refresh site settings"

    with _lock:
        if _running:
            _again = True
            return "site settings refresh already running; one more pass queued"
        _running = True

    try:
        threading.Thread(
            target=_refresh, args=(client,), daemon=True, name='site-settings-refresh',
        ).start()
    except Exception as e:
        # a flag left set here would turn every later refresh into a no-op
        with _lock:
            _running = False
        return f"Error: site_settings_refresh failed: {type(e).__name__}: {e}"
    return "site settings refresh started"


def _refresh(client: Any) -> None:
    """fetch, then once more while requests arrived during the last fetch."""
    global _running, _again
    while True:
        try:
            client._fetch_site_metadata()
        except Exception:
            # it handles its own failures; this only keeps the flag from sticking
            logger.exception("site_settings_refresh: site metadata fetch raised")
        with _lock:
            if not _again:
                _running = False
                return
            _again = False
