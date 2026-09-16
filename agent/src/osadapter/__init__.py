"""The one seam between the agent and the operating system it runs on.

`get()` returns the module implementing `OSAdapter` for this machine, and every
operation is reachable straight off the package (`osadapter.data_root()`).
Windows is the only implementation today.
"""

from __future__ import annotations

import os
import sys
from contextlib import AbstractContextManager
from typing import Protocol

# The one override: set it and the agent's whole data tree moves, on every
# platform it runs on. The Python agent only — the desktop app and
# owlette-host still resolve %ProgramData%\Owlette until task 4.1.
DATA_ROOT_ENV = 'OWLETTE_DATA_ROOT'


class NotSupportedHere(RuntimeError):
    """The operation belongs to another component on this platform.

    Raised by an adapter arm whose work is done elsewhere — on Windows the
    user-session and managed-process operations are OwletteService's — so
    reaching one is a routing mistake, not a missing capability.
    """


class OSAdapter(Protocol):
    """Everything the agent needs from the operating system under it."""

    def data_root(self, sub: str | None = None) -> str:
        """The agent's data tree, or `sub` inside it."""

    def console_user(self) -> str | None:
        """The interactive user at the machine; None when there is no session."""

    def session_env(self, uid) -> dict[str, str]:
        """The environment a process needs to reach that user's display."""

    def spawn_as_user(self, argv, uid) -> int:
        """Run `argv` as `uid` in their session; returns the pid."""

    def run_job(self, job: dict) -> dict:
        """Run a GUI job in the desktop app's session and return its result."""

    def capture_screen(self, path: str) -> int:
        """Capture the user's screen to `path`; returns the monitor count."""

    def launch_managed_process(self, spec: dict) -> int | None:
        """Start a configured managed process; returns its pid, None on failure."""

    def stable_machine_id(self) -> str:
        """An identifier that survives reboots, renames and hardware churn."""

    def key_material(self) -> bytes:
        """Machine-bound material for the token store's key derivation."""

    def service_control(self, verb: str, name: str) -> bool:
        """start / stop / restart a service; True when the control succeeded."""

    def pending_reboot(self) -> dict:
        """Whether the OS is waiting on a reboot, and what is asking for it."""

    def reboot(self, delay: int, message: str | None = None) -> None:
        """Reboot in `delay` seconds; cancellable until it fires."""

    def shutdown(self, delay: int, message: str | None = None) -> None:
        """Power off in `delay` seconds; cancellable until it fires."""

    def cancel_reboot(self) -> bool:
        """Abort a pending reboot or shutdown; True when the OS accepted it."""

    def installed_software(self) -> list[dict[str, str]]:
        """Installed packages: name, version, publisher, uninstall command."""

    def notify(self, title: str, body: str) -> dict:
        """Show a message to whoever is at the machine."""

    def desktop_process_name(self) -> str:
        """The desktop app's image name, for the tray-liveness guard."""

    def json_lock(self) -> AbstractContextManager:
        """The cross-process JSON lock the desktop app takes as well."""

    def streamer_capable(self) -> bool:
        """Whether this machine can drive a streaming session."""


OPERATIONS = tuple(sorted(
    name for name, member in vars(OSAdapter).items()
    if not name.startswith('_') and callable(member)
))

_adapter = None


def get() -> OSAdapter:
    """The adapter for the OS this agent is running on."""
    global _adapter
    if _adapter is None:
        if sys.platform == 'win32':
            from . import win
            _adapter = win
        else:
            raise NotImplementedError(
                f"no osadapter implementation for platform '{sys.platform}'"
            )
    return _adapter


def resolve_data_root(default: str, sub: str | None = None) -> str:
    """`sub` under the data root, `default` naming this OS's own.

    Every adapter's `data_root` resolves through here, so the override is read
    in one place and an arm only has to know where its OS keeps the tree.
    """
    return _under(os.environ.get(DATA_ROOT_ENV) or default, sub)


def data_root(sub: str | None = None) -> str:
    """The agent's data tree, or `sub` inside it.

    The one operation the package can answer without an adapter: an override
    names the root outright, so a relocated tree resolves on a platform whose
    arm has not landed yet.
    """
    override = os.environ.get(DATA_ROOT_ENV)
    if override:
        return _under(override, sub)
    return get().data_root(sub)


def _under(root: str, sub: str | None) -> str:
    """`sub` joined under `root`, absolute — pinned here so nothing downstream
    re-joins it against a different base. A relative override resolves against
    the calling process's cwd, so set the override absolute."""
    return os.path.abspath(os.path.join(root, sub) if sub is not None else root)


def __getattr__(name: str):
    """The operations read straight off the package: `osadapter.data_root()`."""
    if name in OPERATIONS:
        return getattr(get(), name)
    raise AttributeError(f"module '{__name__}' has no attribute '{name}'")
