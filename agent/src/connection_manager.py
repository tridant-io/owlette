"""Connection Manager for Owlette Agent.

SINGLE SOURCE OF TRUTH for connection state. State machine (DISCONNECTED ->
CONNECTING -> CONNECTED, plus RECONNECTING / BACKOFF / FATAL_ERROR), circuit
breaker, thread-supervision watchdog, exponential backoff with jitter, and a
single reconnection queue. Components report failures via report_error() and
clear the counters via report_success().
"""

import datetime
import os
import threading
import time
import random
import socket
import logging
import uuid
from enum import Enum, auto
from typing import Callable, Optional, List, Dict, Any, Tuple
from dataclasses import dataclass, field

import shared_utils
import watchdog_state


# Self-restart watchdog config + enums

# v1 reason code enum — closed set. Extend via new constants, don't reuse values.
REASON_CONNECTION_STUCK = "connection_stuck"

# Defaults used if config.json is missing the watchdog section or keys.
WATCHDOG_DEFAULTS = {
    "enabled": True,
    "thresholds": {"failure_seconds": 360, "boot_grace_seconds": 180},
    "budget": {"max_per_window": 3, "window_seconds": 3600},
    "preconditions": {"require_internet": True, "fatal_error_suppression_seconds": 3600},
}

# Config re-read TTL inside the watchdog — keeps remote kill-switch responsive
# without hammering the cross-process config lock every 10s.
_WATCHDOG_CONFIG_TTL_SECONDS = 60.0

# Cold-boot grace extension: on a slow cold boot (DHCP lease, domain logon, VPN,
# NIC init) the 180s process grace expires while the network is still settling.
_COLD_BOOT_WINDOW_SECONDS = 600.0
_COLD_BOOT_GRACE_SECONDS = 300.0

# registry off switch. from an elevated prompt, disable the watchdog with
#   reg add HKLM\SOFTWARE\Owlette /v WatchdogDisabled /t REG_DWORD /d 1 /f /reg:64
# and clear it with
#   reg delete HKLM\SOFTWARE\Owlette /v WatchdogDisabled /f /reg:64
# checked every cycle — belt-and-braces for when config sync itself is broken.
_EMERGENCY_REG_KEY = r'SOFTWARE\Owlette'
_EMERGENCY_REG_VALUE = 'WatchdogDisabled'
_EMERGENCY_ENV_VAR = "OWLETTE_DISABLE_WATCHDOG_RESTART"

# Throttle the budget-exhausted log; otherwise it repeats every 10s forever.
_BUDGET_EXHAUSTED_LOG_THROTTLE_SECONDS = 3600.0


@dataclass
class RestartDecision:
    """Result of _should_restart() pure function."""
    should_fire: bool
    reason_code: Optional[str] = None
    detail: str = ""


def _should_restart(
    now_mono: float,
    last_success_mono: Optional[float],
    process_start_mono: float,
    last_fatal_mono: Optional[float],
    config: dict,
    system_uptime_seconds: Optional[float] = None,
) -> RestartDecision:
    """Pure decision function — no I/O, no clock reads; the caller supplies all
    timing so this is deterministically testable. Does NOT check internet, budget
    or reboot state (side effects) — see _check_self_restart.

    system_uptime_seconds: seconds since OS boot, or None. Used only to widen the
    boot grace on a cold boot; never as a "time since last success" reference.
    """
    if not config.get('enabled', True):
        return RestartDecision(False, detail="disabled by config")

    thresholds = config.get('thresholds', {})
    preconditions = config.get('preconditions', {})
    failure_seconds = float(thresholds.get('failure_seconds', 360))
    boot_grace_seconds = float(thresholds.get('boot_grace_seconds', 180))
    fatal_suppress_seconds = float(preconditions.get('fatal_error_suppression_seconds', 3600))

    # Boot grace uses process uptime (monotonic). psutil.boot_time() is wall-clock
    # and NTP-vulnerable, so system uptime only ever widens the grace, never shortens
    # it. A configured grace of 0 is an explicit opt-out; implausible uptimes ignored.
    cold_boot_extended = (
        boot_grace_seconds > 0
        and system_uptime_seconds is not None
        and 0 <= system_uptime_seconds < _COLD_BOOT_WINDOW_SECONDS
        and boot_grace_seconds < _COLD_BOOT_GRACE_SECONDS
    )
    if cold_boot_extended:
        boot_grace_seconds = _COLD_BOOT_GRACE_SECONDS

    process_uptime = now_mono - process_start_mono
    if process_uptime < boot_grace_seconds:
        grace_note = " (cold-boot extended)" if cold_boot_extended else ""
        return RestartDecision(
            False,
            detail=f"in boot grace ({process_uptime:.0f}s < {boot_grace_seconds:.0f}s){grace_note}",
        )

    # Fatal-error suppression — if we recently saw an error fingerprint that
    # a restart won't fix (revoked token, deleted project), don't churn.
    if last_fatal_mono is not None:
        fatal_age = now_mono - last_fatal_mono
        if fatal_age < fatal_suppress_seconds:
            return RestartDecision(False, detail=f"fatal-error suppression ({fatal_age:.0f}s < {fatal_suppress_seconds:.0f}s)")

    # Never-connected case (last_success_mono is None): anchor on process start so a
    # process that can't connect at all still fires once the boot grace passes.
    reference_mono = last_success_mono if last_success_mono is not None else process_start_mono
    seconds_since_success = now_mono - reference_mono
    if seconds_since_success < failure_seconds:
        return RestartDecision(False, detail=f"below threshold ({seconds_since_success:.0f}s < {failure_seconds:.0f}s)")

    return RestartDecision(True, reason_code=REASON_CONNECTION_STUCK,
                           detail=f"{seconds_since_success:.0f}s since last success")


def _system_uptime_seconds() -> Optional[float]:
    """Seconds since the OS booted, or None if it can't be determined.

    Wall-clock derived, so only ever used to widen the boot grace — never as the
    authoritative reference. Failures degrade to None rather than kill the watchdog.
    """
    try:
        import psutil
        return time.time() - psutil.boot_time()
    except Exception:
        return None


def _read_watchdog_disabled_value():
    """Raw WatchdogDisabled value from the 64-bit registry view; raises when the
    key or value is absent."""
    import winreg
    with winreg.OpenKey(winreg.HKEY_LOCAL_MACHINE, _EMERGENCY_REG_KEY, 0,
                        winreg.KEY_READ | winreg.KEY_WOW64_64KEY) as key:
        value, _regtype = winreg.QueryValueEx(key, _EMERGENCY_REG_VALUE)
        return value


def _emergency_kill_active() -> bool:
    """Check env var + registry off switch. Cheap; called every watchdog cycle.
    An absent, zero or unreadable value leaves the watchdog enabled."""
    if os.environ.get(_EMERGENCY_ENV_VAR) == "1":
        return True
    try:
        return _read_watchdog_disabled_value() == 1
    except Exception:
        return False


def _merge_watchdog_config(user_cfg: Optional[dict]) -> dict:
    """Merge user config over defaults, one level deep for nested groups."""
    cfg = {k: (v.copy() if isinstance(v, dict) else v) for k, v in WATCHDOG_DEFAULTS.items()}
    if not user_cfg:
        return cfg
    for key, default_value in WATCHDOG_DEFAULTS.items():
        user_value = user_cfg.get(key)
        if user_value is None:
            continue
        if isinstance(default_value, dict) and isinstance(user_value, dict):
            merged = default_value.copy()
            merged.update(user_value)
            cfg[key] = merged
        else:
            cfg[key] = user_value
    return cfg


class ConnectionState(Enum):
    """Connection state machine states.

    DISCONNECTED -> CONNECTING -> CONNECTED; CONNECTED -> RECONNECTING -> BACKOFF
    -> RECONNECTING; any state -> FATAL_ERROR.
    """
    DISCONNECTED = auto()      # Not connected, not actively trying
    CONNECTING = auto()        # Initial connection attempt in progress
    CONNECTED = auto()         # Fully operational
    RECONNECTING = auto()      # Lost connection, attempting recovery
    BACKOFF = auto()           # Waiting before next reconnect attempt
    FATAL_ERROR = auto()       # Unrecoverable error (e.g., machine removed from site)


@dataclass
class ConnectionEvent:
    """Event dispatched on state changes for listeners."""
    old_state: ConnectionState
    new_state: ConnectionState
    reason: str
    timestamp: float = field(default_factory=time.time)


class ConnectionManager:
    """Centralized connection state management for the Owlette agent.

    Single source of truth for connection state; coordinates all reconnection
    attempts, supervises worker threads, dispatches state events, and implements
    the circuit breaker plus jittered exponential backoff.

    Thread safety: state changes under _state_lock (RLock), reconnection under
    _reconnect_lock; events dispatch outside the locks to avoid deadlocks.
    """

    # Backoff configuration
    BACKOFF_BASE = 30.0           # Initial backoff: 30 seconds
    BACKOFF_MAX = 3600.0          # Maximum backoff: 1 hour - ALWAYS keep trying!
    BACKOFF_JITTER = 0.5          # Jitter range: 50-100% of calculated wait

    # Circuit breaker configuration
    FAILURE_THRESHOLD = 5         # Consecutive failures before circuit opens
    RECOVERY_TIMEOUT = 300.0      # 5 minutes before testing recovery

    # "Fatal" error backoff - use longer backoff but NEVER stop trying
    FATAL_ERROR_BACKOFF = 3600.0  # 1 hour backoff for "fatal" errors, but still retry

    # Watchdog configuration
    WATCHDOG_INTERVAL = 10.0      # Check thread health every 10 seconds

    # Internet connectivity check
    CONNECTIVITY_TIMEOUT = 3.0    # Socket timeout for connectivity check
    CONNECTIVITY_HOSTS = [        # Hosts to check for internet (Google DNS, Cloudflare DNS)
        ("8.8.8.8", 53),
        ("1.1.1.1", 53),
    ]

    def __init__(self, logger: Optional[logging.Logger] = None):
        """Initialize the connection manager; creates a logger if none is given."""
        self.logger = logger or logging.getLogger(__name__)

        # State
        self._state = ConnectionState.DISCONNECTED
        self._state_lock = threading.RLock()  # RLock for reentrant access
        self._state_reason = "Not started"

        # Backoff tracking
        self._consecutive_failures = 0
        self._last_attempt_time = 0.0
        self._current_backoff = self.BACKOFF_BASE

        # Circuit breaker
        self._circuit_open = False
        self._circuit_opened_at = 0.0

        # Thread supervision
        self._supervised_threads: Dict[str, threading.Thread] = {}
        self._thread_factories: Dict[str, Callable[[], threading.Thread]] = {}
        self._watchdog_thread: Optional[threading.Thread] = None
        self._shutdown_event = threading.Event()
        self._thread_supervision_enabled = False  # Set True by enable_thread_supervision()

        # Event listeners
        self._state_listeners: List[Callable[[ConnectionEvent], None]] = []
        self._listeners_lock = threading.Lock()

        # Reconnection coordination
        self._reconnect_lock = threading.Lock()
        self._reconnect_in_progress = False
        self._reconnect_thread: Optional[threading.Thread] = None

        # Callbacks injected by FirebaseClient
        self._connect_callback: Optional[Callable[[], bool]] = None
        self._disconnect_callback: Optional[Callable[[], None]] = None
        self._on_connected_callback: Optional[Callable[[], None]] = None

        # Self-restart watchdog state
        # None until the first reported success — "never connected" vs "connected once, now stuck"
        self._last_success_time_mono: Optional[float] = None
        self._last_success_time_wall: Optional[float] = None
        # Process start anchors the boot-grace and the never-connected fallback
        self._process_start_time_mono: float = time.monotonic()
        # Captured by report_error for inclusion in the diagnostic snapshot
        self._last_error_message: Optional[str] = None
        # Last fatal-error fingerprint match — suppresses a self-restart that can't help
        self._last_fatal_error_time_mono: Optional[float] = None
        # Invoked by _check_self_restart when a restart is authorized
        self._restart_callback: Optional[Callable[[int, dict], None]] = None
        # 60s-TTL cache for the watchdog config section (see _read_watchdog_config)
        self._wd_config_cache: Optional[Tuple[float, dict]] = None
        # Throttle for the budget-exhausted log message
        self._budget_exhausted_last_log_mono: Optional[float] = None
        # One-shot flag for the budget_exhausted Firestore event
        self._budget_exhausted_event_emitted: bool = False

        self.logger.debug("ConnectionManager initialized")

    # Properties

    @property
    def state(self) -> ConnectionState:
        """Current connection state (thread-safe read)."""
        with self._state_lock:
            return self._state

    @property
    def state_reason(self) -> str:
        """Reason for current state (thread-safe read)."""
        with self._state_lock:
            return self._state_reason

    @property
    def is_connected(self) -> bool:
        """Check if fully connected and operational."""
        return self.state == ConnectionState.CONNECTED

    @property
    def consecutive_failures(self) -> int:
        """Number of consecutive failures (for monitoring)."""
        return self._consecutive_failures

    @property
    def is_circuit_open(self) -> bool:
        """Check if circuit breaker is open."""
        return self._circuit_open

    # Callback registration

    def set_callbacks(
        self,
        connect: Callable[[], bool],
        disconnect: Optional[Callable[[], None]] = None,
        on_connected: Optional[Callable[[], None]] = None
    ):
        """Register connection callbacks. `connect` returns True on success,
        `disconnect` cleans up at shutdown, `on_connected` fires after each connect."""
        self._connect_callback = connect
        self._disconnect_callback = disconnect
        self._on_connected_callback = on_connected
        self.logger.debug("Connection callbacks registered")

    def add_state_listener(self, listener: Callable[[ConnectionEvent], None]):
        """Register a ConnectionEvent callback. Called synchronously after each state
        change but outside the state lock, to prevent deadlocks."""
        with self._listeners_lock:
            self._state_listeners.append(listener)
        self.logger.debug(f"State listener registered (total: {len(self._state_listeners)})")

    def remove_state_listener(self, listener: Callable[[ConnectionEvent], None]):
        """Remove a previously registered state listener."""
        with self._listeners_lock:
            if listener in self._state_listeners:
                self._state_listeners.remove(listener)

    def set_health_callback(self, callback: Callable[[str, str], None]):
        """Register an (error_code, reason) callback fired on BACKOFF / FATAL_ERROR —
        updates service health for IPC, Firestore and remote alerting."""
        def _health_listener(event: ConnectionEvent):
            if event.new_state in (ConnectionState.BACKOFF, ConnectionState.FATAL_ERROR):
                error_code = (
                    'fatal_error' if event.new_state == ConnectionState.FATAL_ERROR
                    else 'connection_failure'
                )
                try:
                    callback(error_code, event.reason)
                except Exception as e:
                    self.logger.debug(f"Health callback error: {e}")

        self.add_state_listener(_health_listener)
        self.logger.debug("Health callback registered")

    def set_restart_callback(self, callback: Callable[[int, dict], None]):
        """Register the self-restart watchdog callback, (exit_code, snapshot).

        Called when _check_self_restart decides the process should exit for
        self-recovery; must signal a clean exit 43, which the service host
        relaunches from (agent/host/src/supervisor.rs).
        """
        self._restart_callback = callback
        self.logger.debug("Watchdog restart callback registered")

    # State management (internal)

    def _set_state(self, new_state: ConnectionState, reason: str):
        """Thread-safe state transition; events dispatch outside the lock."""
        event = None

        with self._state_lock:
            old_state = self._state
            if old_state == new_state:
                # No change, but update reason
                self._state_reason = reason
                return

            self._state = new_state
            self._state_reason = reason

            log_msg = f"[CONNECTION] {old_state.name} -> {new_state.name}: {reason}"
            if new_state == ConnectionState.CONNECTED:
                self.logger.info(log_msg)
            elif new_state in (ConnectionState.DISCONNECTED, ConnectionState.FATAL_ERROR):
                self.logger.error(log_msg)
            else:
                self.logger.warning(log_msg)

            event = ConnectionEvent(
                old_state=old_state,
                new_state=new_state,
                reason=reason
            )

        # Dispatch event outside lock to prevent deadlocks
        if event:
            self._dispatch_event(event)

    def _dispatch_event(self, event: ConnectionEvent):
        """Dispatch state change event to all listeners."""
        with self._listeners_lock:
            listeners = list(self._state_listeners)

        for listener in listeners:
            try:
                listener(event)
            except Exception as e:
                self.logger.error(f"State listener error: {e}")

    # Connection operations

    def connect(self) -> bool:
        """Establish the first connection. Errors during operation go via report_error()."""
        if self.state == ConnectionState.CONNECTED:
            self.logger.debug("Already connected")
            return True

        if self.state == ConnectionState.FATAL_ERROR:
            self.logger.error("Cannot connect - in FATAL_ERROR state")
            return False

        self._set_state(ConnectionState.CONNECTING, "Initial connection")

        if self._try_connect():
            self._on_connect_success()
            return True
        else:
            self._on_connect_failure("Initial connection failed")
            return False

    def report_error(self, error: Exception, context: str = ""):
        """SINGLE ENTRY POINT for connection-error handling from any component.

        Checks the fatal-error fingerprints and the circuit breaker, then triggers
        reconnection when appropriate.
        """
        error_str = str(error)
        full_context = f"{context}: {error_str}" if context else error_str

        self.logger.warning(f"[ERROR REPORTED] {full_context}")

        # Truncated for the watchdog snapshot — avoid leaking long tokens/project IDs.
        self._last_error_message = error_str[:500] if error_str else None

        # Check for "fatal" errors - these get longer backoff but we STILL retry
        if self._is_fatal_error(error):
            self.logger.warning(f"[FATAL-ISH ERROR] {full_context} - will retry in {self.FATAL_ERROR_BACKOFF}s")
            self._current_backoff = self.FATAL_ERROR_BACKOFF
            # Suppress self-restart while a restart-can't-fix-this error is live
            self._last_fatal_error_time_mono = time.monotonic()
            # DON'T return - still trigger reconnection below!

        if self._circuit_open:
            time_since_open = time.time() - self._circuit_opened_at
            if time_since_open > self.RECOVERY_TIMEOUT:
                self.logger.info(f"[CIRCUIT BREAKER] Testing recovery after {time_since_open:.0f}s")
                self._circuit_open = False
            else:
                remaining = self.RECOVERY_TIMEOUT - time_since_open
                self.logger.debug(f"[CIRCUIT BREAKER] Open, skipping reconnect ({remaining:.0f}s remaining)")
                return

        if self.state == ConnectionState.CONNECTED:
            self._set_state(ConnectionState.DISCONNECTED, full_context)

        self._trigger_reconnect(full_context)

    def report_success(self):
        """Reset failure counters and the circuit breaker after a successful op."""
        if self._consecutive_failures > 0:
            self.logger.debug(f"[SUCCESS] Resetting failure counter (was {self._consecutive_failures})")

        self._consecutive_failures = 0
        self._current_backoff = self.BACKOFF_BASE
        self._circuit_open = False

        # Monotonic is authoritative for "time since last success" (NTP-skew safe);
        # wall-clock is diagnostics only.
        self._last_success_time_mono = time.monotonic()
        self._last_success_time_wall = time.time()
        # A healthy connection is evidence the prior fatal error no longer applies
        self._last_fatal_error_time_mono = None
        # Reset the budget-exhausted one-shot so a later re-exhaustion re-fires
        self._budget_exhausted_event_emitted = False

        if self.state not in (ConnectionState.CONNECTED, ConnectionState.FATAL_ERROR):
            self._set_state(ConnectionState.CONNECTED, "Operation succeeded")

    def force_reconnect(self, reason: str = "Manual reconnect requested"):
        """Force an immediate reconnect, bypassing backoff. Use sparingly."""
        self.logger.info(f"[FORCE RECONNECT] {reason}")

        # Reset backoff to allow immediate retry
        self._current_backoff = self.BACKOFF_BASE
        self._last_attempt_time = 0

        if self.state == ConnectionState.CONNECTED:
            self._set_state(ConnectionState.DISCONNECTED, reason)

        self._trigger_reconnect(reason)

    # =========================================================================
    # Reconnection Logic (Internal)
    # =========================================================================

    def _trigger_reconnect(self, reason: str):
        """Coordinate a reconnect: locked so only one runs at a time, executed on a
        background thread."""
        with self._reconnect_lock:
            if self._reconnect_in_progress:
                self.logger.debug("[RECONNECT] Already in progress, skipping")
                return
            if self._shutdown_event.is_set():
                self.logger.debug("[RECONNECT] Shutdown in progress, skipping")
                return
            self._reconnect_in_progress = True

        thread = threading.Thread(
            target=self._reconnect_sequence,
            args=(reason,),
            daemon=True,
            name="ConnectionManager-Reconnect"
        )
        thread.start()
        self._reconnect_thread = thread

    def _reconnect_sequence(self, reason: str):
        """Execute reconnection with backoff: wait, check connectivity, connect, update
        state. Runs on a background thread."""
        try:
            self._set_state(ConnectionState.RECONNECTING, reason)

            wait_time = self._calculate_backoff_wait()
            if wait_time > 0:
                self._set_state(ConnectionState.BACKOFF, f"Waiting {wait_time:.0f}s before retry")
                self.logger.debug(f"[BACKOFF] Waiting {wait_time:.0f}s (attempt #{self._consecutive_failures + 1})")

                # Interruptible sleep
                if self._shutdown_event.wait(wait_time):
                    self.logger.debug("[RECONNECT] Interrupted by shutdown")
                    return

            self._set_state(ConnectionState.RECONNECTING, "Attempting reconnection")
            self._last_attempt_time = time.time()

            if not self._check_internet():
                self._on_connect_failure("No internet connectivity")
                return

            if self._try_connect():
                self._on_connect_success()
            else:
                self._on_connect_failure("Reconnection attempt failed")

        except Exception as e:
            self.logger.error(f"[RECONNECT] Unexpected error: {e}")
            self._on_connect_failure(f"Unexpected error: {e}")
        finally:
            with self._reconnect_lock:
                self._reconnect_in_progress = False

    def _try_connect(self) -> bool:
        """Execute the connect callback; True on success."""
        if not self._connect_callback:
            self.logger.error("[CONNECT] No connect callback registered")
            return False

        try:
            result = self._connect_callback()
            if result:
                self.logger.debug("[CONNECT] Callback returned success")
            else:
                self.logger.warning("[CONNECT] Callback returned failure")
            return result
        except Exception as e:
            self.logger.error(f"[CONNECT] Callback raised exception: {e}")
            return False

    def _on_connect_success(self):
        """Handle successful connection."""
        self._consecutive_failures = 0
        self._current_backoff = self.BACKOFF_BASE
        self._circuit_open = False

        # Stamp for watchdog — a successful reconnect counts as "alive"
        self._last_success_time_mono = time.monotonic()
        self._last_success_time_wall = time.time()
        self._last_fatal_error_time_mono = None
        self._budget_exhausted_event_emitted = False

        self._set_state(ConnectionState.CONNECTED, "Connection established")

        # Don't start supervised threads before the service is ready
        if self._thread_supervision_enabled:
            self._restart_all_threads()
        else:
            self.logger.debug("[CONNECT] Thread supervision not yet enabled, skipping thread restart")

        if self._on_connected_callback:
            try:
                self._on_connected_callback()
            except Exception as e:
                self.logger.error(f"[CONNECT] on_connected callback error: {e}")

    def _on_connect_failure(self, reason: str):
        """Increment the failure counter, grow backoff, check the circuit breaker and
        transition to DISCONNECTED. Does NOT schedule the next attempt — see below."""
        self._consecutive_failures += 1
        self._current_backoff = min(
            self._current_backoff * 2,
            self.BACKOFF_MAX
        )

        if self._consecutive_failures >= self.FAILURE_THRESHOLD:
            if not self._circuit_open:
                self._circuit_open = True
                self._circuit_opened_at = time.time()
                self.logger.warning(
                    f"[CIRCUIT BREAKER] OPEN after {self._consecutive_failures} failures. "
                    f"Recovery test in {self.RECOVERY_TIMEOUT:.0f}s"
                )

        self._set_state(
            ConnectionState.DISCONNECTED,
            f"{reason} (attempt #{self._consecutive_failures})"
        )

        # No retry is scheduled here, by design. The metrics loop is the SOLE reconnect
        # driver: while DISCONNECTED it calls force_reconnect() on every 30s poll
        # (firebase_client._metrics_loop), which covers failed-initial-connect too.
        # A _trigger_reconnect() here would be dead code anyway — this method is reached
        # from inside _reconnect_sequence, which still holds _reconnect_in_progress.
        # Do NOT reinstate the self-perpetuating retry ladder.

    def _calculate_backoff_wait(self) -> float:
        """Exponential backoff with 50-100% jitter to avoid a thundering herd when many
        agents reconnect at once. Returns seconds to wait (0 = none)."""
        elapsed = time.time() - self._last_attempt_time
        base_wait = self._current_backoff - elapsed

        if base_wait <= 0:
            return 0

        jitter_factor = self.BACKOFF_JITTER + random.random() * self.BACKOFF_JITTER
        return base_wait * jitter_factor

    def _check_internet(self) -> bool:
        """Quick TCP connectivity probe against CONNECTIVITY_HOSTS; True if any answers."""
        for host, port in self.CONNECTIVITY_HOSTS:
            try:
                with socket.create_connection(
                    (host, port),
                    timeout=self.CONNECTIVITY_TIMEOUT
                ) as sock:
                    pass
                self.logger.debug(f"[INTERNET] Connectivity confirmed via {host}")
                return True
            except OSError:
                continue

        self.logger.warning("[INTERNET] No connectivity detected")
        return False

    # Fatal error handling

    def _is_fatal_error(self, error: Exception) -> bool:
        """True for unrecoverable errors: machine removed, site not found, permission
        denied, account disabled, revoked credential."""
        error_str = str(error).lower()

        fatal_indicators = [
            "machine not found",
            "machine has been removed",
            "site not found",
            "permission denied",
            "not authorized",
            "account disabled",
            "credential revoked",
            "invalid_grant",  # OAuth token permanently invalid
        ]

        return any(indicator in error_str for indicator in fatal_indicators)

    def _handle_fatal_error(self, error: Exception):
        """Log a serious error that may indicate a config problem. Reconnection is never
        disabled — we keep retrying on the longer backoff; the admin may need to re-register."""
        self.logger.warning(f"[SERIOUS ERROR] {error}")
        self.logger.warning("[SERIOUS ERROR] Will keep retrying every hour - may need re-registration")
        # Deliberately does NOT set shutdown_event — always keep trying

    # Thread supervision

    def register_thread(
        self,
        name: str,
        factory: Callable[[], threading.Thread]
    ):
        """Register a supervised thread. `factory` returns an unstarted Thread and is
        called again to restart it if it dies while connected."""
        self._thread_factories[name] = factory
        self.logger.debug(f"[SUPERVISOR] Registered thread: {name}")

    def _restart_all_threads(self):
        """Restart all supervised threads after successful connection."""
        for name, factory in self._thread_factories.items():
            self._restart_thread(name, factory)

    def _restart_thread(self, name: str, factory: Callable[[], threading.Thread]):
        """Restart one supervised thread from its factory."""
        existing = self._supervised_threads.get(name)
        if existing and existing.is_alive():
            self.logger.debug(f"[SUPERVISOR] Thread {name} already running")
            return

        # Wait briefly for old thread to finish
        if existing:
            try:
                existing.join(timeout=1.0)
            except Exception:
                pass

        try:
            thread = factory()
            thread.name = f"Supervised-{name}"
            thread.daemon = True
            thread.start()
            self._supervised_threads[name] = thread
            self.logger.debug(f"[SUPERVISOR] Started thread: {name}")
        except Exception as e:
            self.logger.error(f"[SUPERVISOR] Failed to start thread {name}: {e}")

    def enable_thread_supervision(self):
        """Enable thread supervision. Must be called before start_watchdog() so threads
        start at the right time."""
        self._thread_supervision_enabled = True
        self.logger.debug("[SUPERVISOR] Thread supervision enabled")

        # If already connected, start threads now
        if self.state == ConnectionState.CONNECTED:
            self._restart_all_threads()

    def start_watchdog(self):
        """Start the supervision watchdog (also enables thread supervision). Monitors
        supervised threads and triggers reconnection when one dies."""
        if not self._thread_supervision_enabled:
            self.enable_thread_supervision()

        if self._watchdog_thread and self._watchdog_thread.is_alive():
            self.logger.debug("[WATCHDOG] Already running")
            return

        self._watchdog_thread = threading.Thread(
            target=self._watchdog_loop,
            daemon=True,
            name="ConnectionManager-Watchdog"
        )
        self._watchdog_thread.start()
        self.logger.debug("[WATCHDOG] Started")

    def _watchdog_loop(self):
        """Monitor supervised threads at WATCHDOG_INTERVAL and restart dead ones."""
        self.logger.debug("[WATCHDOG] Loop started")

        while not self._shutdown_event.is_set():
            try:
                if self.state == ConnectionState.CONNECTED:
                    dead_threads = []

                    for name, thread in list(self._supervised_threads.items()):
                        if not thread.is_alive():
                            dead_threads.append(name)

                    if dead_threads:
                        self.logger.warning(
                            f"[WATCHDOG] Dead threads detected: {dead_threads}"
                        )
                        # Report as error to trigger reconnection
                        self.report_error(
                            Exception(f"Supervised threads died: {dead_threads}"),
                            context="Watchdog"
                        )

                # Runs regardless of state — the point is to catch never-reaching-CONNECTED
                self._check_self_restart()

            except Exception as e:
                self.logger.error(f"[WATCHDOG] Error: {e}")

            self._shutdown_event.wait(self.WATCHDOG_INTERVAL)

        self.logger.debug("[WATCHDOG] Loop exited")

    # Self-restart watchdog

    def _read_watchdog_config(self) -> dict:
        """Read the watchdog config section, cached for 60s to cut lock churn."""
        now_mono = time.monotonic()
        if self._wd_config_cache is not None:
            cached_at, cached_cfg = self._wd_config_cache
            if now_mono - cached_at < _WATCHDOG_CONFIG_TTL_SECONDS:
                return cached_cfg
        try:
            raw = shared_utils.read_config(['watchdog']) or {}
        except Exception as e:
            self.logger.debug(f"[WATCHDOG] config read failed, using defaults: {e}")
            raw = {}
        merged = _merge_watchdog_config(raw if isinstance(raw, dict) else {})
        self._wd_config_cache = (now_mono, merged)
        return merged

    def _build_snapshot(self, reason_code: str) -> dict:
        """Diagnostic snapshot for restart logging and deferred Firestore submission."""
        snap = self.get_status(diagnostic=True)
        snap["reason_code"] = reason_code
        snap["restart_id"] = str(uuid.uuid4())
        snap["agent_version"] = getattr(shared_utils, "APP_VERSION", "unknown")
        try:
            snap["pid"] = os.getpid()
        except Exception:
            snap["pid"] = None
        return snap

    def _check_self_restart(self):
        """Evaluate whether to fire a self-restart this cycle.

        Ordering is deliberate: cheap checks first (config, kill switch, pure
        decision), then expensive ones (internet, reboot state, budget consume).
        All I/O is wrapped so a failure here never kills the watchdog thread.
        """
        try:
            config = self._read_watchdog_config()
            if not config.get('enabled', True):
                return
            if _emergency_kill_active():
                return

            decision = _should_restart(
                now_mono=time.monotonic(),
                last_success_mono=self._last_success_time_mono,
                process_start_mono=self._process_start_time_mono,
                last_fatal_mono=self._last_fatal_error_time_mono,
                config=config,
                system_uptime_seconds=_system_uptime_seconds(),
            )
            if not decision.should_fire:
                return

            # Expensive precondition checks only after pure logic clears
            if config.get('preconditions', {}).get('require_internet', True):
                if not self._check_internet():
                    self.logger.info("[WATCHDOG] Fire condition met but internet unreachable; skipping")
                    return

            # Don't inject a service restart while the reboot scheduler drives a shutdown
            try:
                import reboot_state  # lazy import to avoid cycles
                if reboot_state.read_state().get('attempt'):
                    self.logger.info("[WATCHDOG] Fire condition met but scheduled reboot in progress; skipping")
                    return
            except Exception as e:
                self.logger.debug(f"[WATCHDOG] reboot_state check failed (non-fatal): {e}")

            # Budget check + atomic consume. Fail-closed on write error.
            if not watchdog_state.consume_budget(config.get('budget', {})):
                self._handle_budget_exhausted(decision)
                return

            if self._restart_callback is None:
                self.logger.warning(
                    "[WATCHDOG] Fire condition met but no restart callback registered; skipping"
                )
                return

            snapshot = self._build_snapshot(decision.reason_code)
            try:
                watchdog_state.append_history(snapshot)
            except Exception as e:
                self.logger.error(f"[WATCHDOG] history append failed (non-fatal): {e}")

            self.logger.error(
                f"[WATCHDOG] Self-restart authorized: {decision.detail} — "
                f"invoking restart callback with exit code 43"
            )
            self._restart_callback(43, snapshot)
        except Exception as e:
            self.logger.error(f"[WATCHDOG] _check_self_restart error (non-fatal): {e}")

    def _handle_budget_exhausted(self, decision: RestartDecision):
        """Log once per window instead of every 10s, and emit a one-shot Firestore event
        so the dashboard can see the agent is 'wedged but alive'."""
        now_mono = time.monotonic()
        last_log = self._budget_exhausted_last_log_mono
        if last_log is None or (now_mono - last_log) > _BUDGET_EXHAUSTED_LOG_THROTTLE_SECONDS:
            self.logger.error(
                "[WATCHDOG] Self-restart budget exhausted — running in degraded mode. "
                f"Detail: {decision.detail}. Normal reconnect retries continue; "
                "operator may re-enable via config or clear the WatchdogDisabled registry value."
            )
            self._budget_exhausted_last_log_mono = now_mono

        # One-shot pending event (flushed by owlette_service on next connect)
        if not self._budget_exhausted_event_emitted:
            try:
                snapshot = self._build_snapshot(decision.reason_code or REASON_CONNECTION_STUCK)
                snapshot["event_kind"] = "watchdog_budget_exhausted"
                watchdog_state.append_history(snapshot)
                self._budget_exhausted_event_emitted = True
            except Exception as e:
                self.logger.debug(f"[WATCHDOG] budget_exhausted event persist failed: {e}")

    def get_thread_status(self) -> Dict[str, bool]:
        """Map supervised thread name -> alive."""
        return {
            name: thread.is_alive()
            for name, thread in self._supervised_threads.items()
        }

    # Lifecycle

    def shutdown(self):
        """Graceful shutdown: stop threads, run the disconnect callback, go DISCONNECTED."""
        self.logger.info("[SHUTDOWN] ConnectionManager shutting down")

        self._shutdown_event.set()

        if self._disconnect_callback:
            try:
                self._disconnect_callback()
            except Exception as e:
                self.logger.error(f"[SHUTDOWN] Disconnect callback error: {e}")

        if self._watchdog_thread and self._watchdog_thread.is_alive():
            self._watchdog_thread.join(timeout=5.0)

        # Wait for any in-flight reconnect attempt
        if self._reconnect_thread and self._reconnect_thread.is_alive():
            self._reconnect_thread.join(timeout=5.0)

        self._set_state(ConnectionState.DISCONNECTED, "Shutdown complete")
        self.logger.info("[SHUTDOWN] Complete")

    def reset(self):
        """Reset to initial state — for tests or agent re-registration."""
        self.logger.info("[RESET] Resetting ConnectionManager")

        self._shutdown_event.clear()
        self._consecutive_failures = 0
        self._current_backoff = self.BACKOFF_BASE
        self._last_attempt_time = 0
        self._circuit_open = False
        self._circuit_opened_at = 0

        with self._reconnect_lock:
            self._reconnect_in_progress = False

        self._set_state(ConnectionState.DISCONNECTED, "Reset")

    # Status / debugging

    def get_status(self, diagnostic: bool = False) -> Dict[str, Any]:
        """Status for debugging/monitoring.

        diagnostic=True adds the self-restart watchdog fields
        (seconds_since_last_success, internet_check_tcp, last_error,
        process_uptime_s, restart_count_in_window, timestamp_utc).
        """
        status = {
            "state": self.state.name,
            "state_reason": self._state_reason,
            "consecutive_failures": self._consecutive_failures,
            "current_backoff": self._current_backoff,
            "circuit_open": self._circuit_open,
            "circuit_opened_at": self._circuit_opened_at,
            "reconnect_in_progress": self._reconnect_in_progress,
            "shutdown_requested": self._shutdown_event.is_set(),
            "threads": self.get_thread_status(),
        }
        if diagnostic:
            now_mono = time.monotonic()
            if self._last_success_time_mono is not None:
                status["seconds_since_last_success"] = int(now_mono - self._last_success_time_mono)
            else:
                status["seconds_since_last_success"] = None  # never connected
            status["last_error"] = self._last_error_message
            status["process_uptime_s"] = int(now_mono - self._process_start_time_mono)
            status["timestamp_utc"] = datetime.datetime.now(datetime.timezone.utc).isoformat()
            # Internet check is cheap (<3s) and directly relevant to diagnosis
            try:
                status["internet_check_tcp"] = self._check_internet()
            except Exception as e:
                status["internet_check_tcp"] = None
                self.logger.debug(f"diagnostic internet_check failed: {e}")
            # Budget count reflects recent self-restart pressure
            try:
                budget = watchdog_state.read_budget()
                status["restart_count_in_window"] = len(budget.get('restarts', []))
            except Exception as e:
                status["restart_count_in_window"] = None
                self.logger.debug(f"diagnostic budget read failed: {e}")
        return status

    def __repr__(self) -> str:
        return (
            f"ConnectionManager(state={self.state.name}, "
            f"failures={self._consecutive_failures}, "
            f"circuit_open={self._circuit_open})"
        )
