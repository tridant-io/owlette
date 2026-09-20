"""
command_router — registry-based dispatch for Firebase commands.

introduced for roost (project distribution v2). new v2 command handlers
(sync_pull, cancel_sync, rollback_to_version) register here. existing v1
handlers in OwletteService.handle_firebase_command's if/elif chain remain in place
and migrate incrementally as each is touched.

design: minimum-disruption primitive. CommandRouter holds a {cmd_type:
callable} map. OwletteService.handle_firebase_command checks the router
first; if the type is registered, dispatches. otherwise falls through to
the existing chain. this lets new handlers use the new pattern from day 1
without forcing a 5,000-line refactor.

CLAUDE.md compliance:
- no firebase_admin import (unused; this module is dispatch only)
- no blocking ops in main loop (handlers run on _slow_command_worker thread)
- no token logging
"""

from __future__ import annotations

import logging
from typing import Callable, Dict, Optional, Any

logger = logging.getLogger(__name__)


# What a handler returns instead of a result when it finishes its work on a
# thread of its own: the command lane is released at once and the terminal
# status is that thread's to write, through FirebaseClient.finish_command. The
# alternative is a progress write landing after the lane has already marked the
# command terminal, which leaves the row non-terminal for good.
COMMAND_DEFERRED = object()


# command handler signature: (cmd_data, cmd_id, service) -> str
# - cmd_data: full command dict from firestore
# - cmd_id: command id string
# - service: OwletteService instance, for handler access to state/clients
# - returns: human-readable result string written to firestore on completion
CommandHandler = Callable[[dict, str, Any], str]


class CommandRouter:
    """
    registry-based dispatcher. handlers register against a command type
    string and receive (cmd_data, cmd_id, service_context) when dispatched.

    handlers are responsible for their own:
    - parameter validation (raise ValueError for bad input → router catches)
    - threading discipline (always called on _slow_command_worker thread)
    - firestore status updates via service.firebase_client
    """

    def __init__(self) -> None:
        self._handlers: Dict[str, CommandHandler] = {}

    def register(self, cmd_type: str) -> Callable[[CommandHandler], CommandHandler]:
        """
        decorator: register a handler for a command type.

            router = CommandRouter()

            @router.register('sync_pull')
            def handle_sync_pull(cmd_data, cmd_id, service):
                ...
                return 'synced 12 files'

        raises ValueError on duplicate registration (catches typos + double-wires).
        """
        def decorator(fn: CommandHandler) -> CommandHandler:
            if cmd_type in self._handlers:
                raise ValueError(
                    f"command type '{cmd_type}' already registered with "
                    f"{self._handlers[cmd_type].__qualname__}"
                )
            self._handlers[cmd_type] = fn
            logger.debug(f"command_router: registered handler for '{cmd_type}'")
            return fn
        return decorator

    def register_fn(self, cmd_type: str, handler: CommandHandler) -> None:
        """non-decorator form for runtime registration (e.g. dynamic plugins)."""
        if cmd_type in self._handlers:
            raise ValueError(
                f"command type '{cmd_type}' already registered with "
                f"{self._handlers[cmd_type].__qualname__}"
            )
        self._handlers[cmd_type] = handler
        logger.debug(f"command_router: registered handler for '{cmd_type}'")

    def has_handler(self, cmd_type: str) -> bool:
        """true if a handler is registered for this command type."""
        return cmd_type in self._handlers

    def dispatch(self, cmd_type: str, cmd_data: dict, cmd_id: str, service: Any) -> str:
        """
        invoke the handler for cmd_type. returns its string result.

        raises KeyError if no handler is registered (caller should check
        has_handler first, or fall through to legacy dispatch).

        handler exceptions are NOT caught here — caller (handle_firebase_command)
        already wraps the dispatch in a try/except for uniform error handling.
        """
        handler = self._handlers.get(cmd_type)
        if handler is None:
            raise KeyError(f"no handler registered for command type '{cmd_type}'")
        return handler(cmd_data, cmd_id, service)

    def registered_types(self) -> list[str]:
        """return all registered command types (for diagnostics / tests)."""
        return sorted(self._handlers.keys())
