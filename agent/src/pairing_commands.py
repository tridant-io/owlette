"""
pairing_commands — the handler for `unpair`.

The dashboard queues it on a machine whose agent token it has just revoked
(`POST /api/sites/{siteId}/agent-tokens/revoke`). Deleting the token alone
changes nothing for up to an hour: the agent syncs on its access token and only
learns of the revoke at its next refresh, so the machine stayed online with live
metrics after the revoke it had just been told disconnected it (#327). This
command reaches a running agent on its next command poll instead.

The handler does not take the command's word for it: it asks the server for a
refresh first, and only a refused refresh unpairs (through `AuthManager`'s
on_revoked hook, the same exit a machine that was offline during the revoke
takes when it returns). A refresh the server accepts means the command is not
about this credential: a sibling sharing the hostname whose own token survived,
or a command left queued for a machine that has since been paired again. A
refresh that could not be asked at all is settled the dashboard's way.

It always defers rather than completing. After an unpair, a completion would
push metrics with `online: true` behind the `online: false` flush the main loop
is about to make; after an ignore, completing would delete the command from
`pending` before the sibling it was meant for has polled it. Left pending, it
is run once per agent (`_seen_commands`) and swept with the hour-old commands.

The type rides the fast lane (`firebase_client._FAST_COMMAND_TYPES`), so a
revoke never waits behind an install.
"""

from __future__ import annotations

import logging
from typing import Any

from auth_manager import TokenRefreshError, TokenRevokedError
from command_router import COMMAND_DEFERRED, CommandRouter

logger = logging.getLogger(__name__)

UNPAIR_REASON = 'the agent token was revoked from the dashboard'


def register_handlers(router: CommandRouter) -> None:
    """register the pairing handler on the given CommandRouter, once at init."""
    router.register("unpair")(handle_unpair)
    logger.info("pairing_commands: registered handler — unpair")


def handle_unpair(cmd_data: dict, cmd_id: str, service: Any):
    """confirm the revoke with the server, then leave the site; see the module
    docstring for why this never completes the command."""
    client = getattr(service, 'firebase_client', None)
    if client is None:
        return "Error: firebase client unavailable; cannot confirm the revoke"

    try:
        client.auth_manager.refresh_now()
    except TokenRevokedError:
        # the on_revoked hook has already unpaired
        logger.info(f"unpair {cmd_id}: the server refused this machine's agent token")
        return COMMAND_DEFERRED
    except TokenRefreshError as e:
        service.unpair(f"{UNPAIR_REASON} (could not confirm with the server: {e})")
        return COMMAND_DEFERRED

    logger.warning(f"unpair {cmd_id} ignored: the server still accepts this machine's agent token")
    return COMMAND_DEFERRED
