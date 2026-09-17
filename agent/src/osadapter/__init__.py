"""The one seam between the agent and the operating system it runs on.

`get()` returns the module implementing `OSAdapter` for this machine, and every
operation is reachable straight off the package (`osadapter.data_root()`).
"""

from __future__ import annotations

import importlib.util
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

    def capture_screen(self, monitor: int, *, executor, timeout_s: int) -> dict:
        """Grab `monitor` where the user can see it.

        Answers the `{outputDir, files, stdout}` dict
        screenshot_capture.capture_in_user_session parses, or one carrying an
        `error` the caller surfaces. `executor` is the service's user-session
        round-trip, which only the Windows arm runs through.
        """

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

# The arm each platform runs. `posix` is the half macOS and Linux share and is
# never selected in its own right — `linux.py` and `darwin.py` import what they
# share from it and answer the rest themselves. An arm that is not in the tree
# yet resolves to nothing, so a platform whose work is still to come raises
# NotImplementedError instead of ImportError.
_ARMS = {'win32': 'win', 'linux': 'linux', 'darwin': 'darwin'}

_adapter = None


def get() -> OSAdapter:
    """The adapter for the OS this agent is running on."""
    global _adapter
    if _adapter is None:
        name = _ARMS.get(sys.platform)
        arm = _arm(name) if name else None
        if arm is None:
            raise NotImplementedError(
                f"no osadapter implementation for platform '{sys.platform}'"
            )
        _adapter = arm
    return _adapter


def _arm(name: str):
    """The arm module, or None when that branch is not in the tree.

    find_spec first, so an ImportError raised *inside* an arm is the caller's
    to see rather than reading as an arm that is not there at all.
    """
    if importlib.util.find_spec(f'.{name}', __name__) is None:
        return None
    return importlib.import_module(f'.{name}', __name__)


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
