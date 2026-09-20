"""
swoop_commands — command handlers for the three swoop command types.

Registers `swoop_session_requested`, `swoop_kill` and `swoop_refresh` on the
CommandRouter, shaped like `machine_commands.register_handlers`. Task 3.1 wires
this module into OwletteService; nothing here touches that file.

These three types are on the fast command lane (`firebase_client._FAST_COMMAND_TYPES`),
so every handler is a validate-and-hand-off: no network, no sleep, no disk. A kill
that queues behind an in-flight install is a kill switch that arrives minutes late.

THE SID-ONLY CONTRACT (PROTOCOL.md §11): a swoop command is a notification, never a
carrier. Every active site member can read `commands/pending`, so the document holds
only the envelope the web writer stamps plus, per type, a sid:

  * `swoop_session_requested` — sid mandatory
  * `swoop_kill`              — sid optional (absent means "kill whatever is running")
  * `swoop_refresh`           — no sid, ever (an enablement toggle names no session)

Anything else in the payload is refused rather than ignored: a field that should be
impossible is a signal, and silently dropping it would hide the day one appears.

FAILURE REPORTING: a refusal returns a string starting with `Error:`, which is what
`firebase_client._execute_command:1625` keys off to mark the command failed. Without
the prefix a refused command is recorded as a success.

The sid is the only payload value that may be logged — no bundle, token or key ever
reaches this module, and none may be logged from it.
"""

from __future__ import annotations

import logging
from typing import Any, Optional, Tuple

from command_router import CommandRouter

logger = logging.getLogger(__name__)

# what the web writer stamps on every command document: the envelope from
# executeMachineCommand.server.ts plus stampCommand's lifecycle fields
# (commandLifecycle.ts:65-79). the agent's own run markers go to the `completed`
# document, not to this one, so these are the only keys a handler can expect.
_ENVELOPE_FIELDS = frozenset({
    'type', 'siteId', 'machineId', 'timestamp', 'status', 'queuedBy',
    'createdAt', 'expiresAt', 'auditCorrelationId',
})


def register_handlers(router: CommandRouter) -> None:
    """
    register the swoop handlers on the given CommandRouter.
    called once at OwletteService init time after the router is created.
    """
    router.register("swoop_session_requested")(_handle_swoop_session_requested)
    router.register("swoop_kill")(_handle_swoop_kill)
    router.register("swoop_refresh")(_handle_swoop_refresh)
    logger.info(
        "swoop_commands: registered handlers — swoop_session_requested, "
        "swoop_kill, swoop_refresh"
    )


def _check_payload(cmd_data: dict, cmd_type: str, sid_allowed: bool) -> Optional[str]:
    """`Error: …` when the payload carries anything outside its contract, else None."""
    allowed = (_ENVELOPE_FIELDS | {'sid'}) if sid_allowed else _ENVELOPE_FIELDS
    extra = sorted(set(cmd_data) - allowed)
    if extra:
        return (
            f"Error: {cmd_type} refused — unexpected field(s) {', '.join(extra)}; "
            f"a swoop command carries the envelope and, where the type takes one, a sid"
        )
    return None


def _read_sid(cmd_data: dict, cmd_type: str, required: bool) -> Tuple[Optional[str], Optional[str]]:
    """(sid, error). a present sid must be a non-empty string whatever the type."""
    sid = cmd_data.get('sid')
    if sid is None:
        if required:
            return None, f"Error: {cmd_type} refused — sid is required"
        return None, None
    if not isinstance(sid, str) or not sid.strip():
        return None, f"Error: {cmd_type} refused — sid must be a non-empty string"
    return sid, None


def _manager(service: Any, cmd_type: str) -> Tuple[Optional[Any], Optional[str]]:
    """(swoop_manager, error). absent manager is a failure, not an exception."""
    manager = getattr(service, 'swoop_manager', None)
    if manager is None:
        return None, f"Error: swoop_manager unavailable; cannot dispatch {cmd_type}"
    return manager, None


def _handle_swoop_session_requested(cmd_data: dict, cmd_id: str, service: Any) -> str:
    """start (or attach to) the streamer for this sid. returns immediately."""
    err = _check_payload(cmd_data, 'swoop_session_requested', sid_allowed=True)
    if err:
        return err
    sid, err = _read_sid(cmd_data, 'swoop_session_requested', required=True)
    if err:
        return err

    manager, err = _manager(service, 'swoop_session_requested')
    if err:
        return err

    try:
        manager.ensure_streamer(sid)
    except Exception as e:
        logger.exception("swoop_session_requested: ensure_streamer failed")
        return f"Error: swoop_session_requested failed: {type(e).__name__}: {e}"

    return f"swoop streamer requested for sid {sid}"


def _handle_swoop_kill(cmd_data: dict, cmd_id: str, service: Any) -> str:
    """kill the live streamer. an absent sid means whatever is running."""
    err = _check_payload(cmd_data, 'swoop_kill', sid_allowed=True)
    if err:
        return err
    sid, err = _read_sid(cmd_data, 'swoop_kill', required=False)
    if err:
        return err

    manager, err = _manager(service, 'swoop_kill')
    if err:
        return err

    reason = f"swoop_kill sid={sid}" if sid else "swoop_kill any"
    try:
        manager.kill(reason)
    except Exception as e:
        logger.exception("swoop_kill: kill failed")
        return f"Error: swoop_kill failed: {type(e).__name__}: {e}"

    return f"swoop kill requested ({reason})"


def _handle_swoop_refresh(cmd_data: dict, cmd_id: str, service: Any) -> str:
    """
    site enablement changed. the manager's on_session_change() pokes the doorbell
    (spike 0.6); this handler never reaches the doorbell itself.
    """
    err = _check_payload(cmd_data, 'swoop_refresh', sid_allowed=False)
    if err:
        return err

    manager, err = _manager(service, 'swoop_refresh')
    if err:
        return err

    try:
        manager.on_session_change()
    except Exception as e:
        logger.exception("swoop_refresh: on_session_change failed")
        return f"Error: swoop_refresh failed: {type(e).__name__}: {e}"

    return "swoop refresh applied"
