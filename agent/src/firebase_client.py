"""
Firebase Client for Owlette 2.0

Presence/heartbeat, config sync with offline cache, command queue and metrics.
Auth is OAuth custom-token over the Firestore REST API (never firebase_admin,
never a service-account json). All reconnection/backoff/circuit-breaking lives
in ConnectionManager — do not spawn reconnect logic here.
"""

import queue
import threading
import time
import json
import os
import logging
import hashlib
from typing import Dict, Any, Callable, Optional
from datetime import datetime

import shared_utils
import hardware_profile
import config_sync

# OAuth REST modules — deliberately not firebase_admin
from auth_manager import AuthManager, AuthenticationError, TokenRefreshError
from firestore_rest_client import FirestoreRestClient, SERVER_TIMESTAMP, DELETE_FIELD, timestamp_to_ms

from command_router import COMMAND_DEFERRED
from connection_manager import ConnectionManager, ConnectionState, ConnectionEvent

# Per-request cap once shutdown starts. Windows gives roughly 5s at OS shutdown,
# so anything that can outlast the window is worse than not trying.
SHUTDOWN_REQUEST_TIMEOUT = 3.0


# Display events `POST /api/agent/alert` can route. Mirrors DISPLAY_EVENT_ROUTING
# in web/lib/alerts/displayEventRouting.ts; duplicated (not fetched) because the
# agent must route offline. The endpoint re-validates, so drift here degrades to
# "log-only", never a bad write.
# Excluded on purpose — display_auto_restore_fired, display_apply_acked,
# display_revert_deferred, display_auto_restore_skipped_unfixable,
# display_auto_restore_circuit_breaker_tripped: no routing entry, so they hit the
# endpoint's generic branch and duplicate the log doc the agent already wrote.
DISPLAY_ALERT_EVENT_TYPES = frozenset({
    # email + webhook
    'display_monitor_removed',
    'display_apply_failed',
    'display_auto_revert_fired',
    'display_sync_lost',
    # webhook only
    'display_drift',
    'display_monitor_swapped',
    'display_mosaic_disabled',
    'display_apply_refused_mosaic',
    # in-dashboard only (endpoint still accepts + rate-limits them)
    'display_monitor_added',
    'display_apply_succeeded',
})


def should_emit_progress(
    prev_state: Optional[dict],
    status: str,
    progress: Optional[int],
    force: bool,
    now: float,
    min_seconds: float,
    min_pct: int,
) -> tuple:
    """
    Pure throttle decision for update_command_progress.

    Returns (should_emit, new_state); caller persists new_state on emit.
    Coalesces same-status writes inside BOTH thresholds (time AND percent);
    status changes and force=True always emit.

    Module-level so it is unit-testable without constructing FirebaseClient
    (which pulls in cryptography/PyO3 and fights pytest's interpreter reuse).
    """
    new_state = {'ts': now, 'status': status, 'progress': progress}
    if force:
        return True, new_state
    if prev_state is None or prev_state.get('status') != status:
        # never throttle status transitions or first writes
        return True, new_state
    elapsed = now - prev_state['ts']
    last_pct = prev_state.get('progress')
    if progress is not None and last_pct is not None:
        pct_delta = abs(progress - last_pct)
    else:
        pct_delta = 0
    if elapsed < min_seconds and pct_delta < min_pct:
        return False, prev_state  # coalesce: skip this write
    return True, new_state


def _register_pending_sync_cancel(cmd_data: Dict[str, Any]):
    """Register sync_pull cancellation before the command enters the slow queue."""
    if cmd_data.get('type') != 'sync_pull':
        return None

    site_id = cmd_data.get('site_id')
    roost_id = cmd_data.get('roost_id')
    version_id = cmd_data.get('version_id')
    if not (
        isinstance(site_id, str) and site_id
        and isinstance(roost_id, str) and roost_id
        and isinstance(version_id, str) and version_id
    ):
        return None

    from sync_commands import register_pending_sync

    cancel_event = register_pending_sync(site_id, roost_id, version_id)
    return site_id, roost_id, version_id, cancel_event


def _discard_pending_sync_cancel(registration) -> None:
    if registration is None:
        return

    site_id, roost_id, version_id, cancel_event = registration
    from sync_commands import discard_pending_sync

    discard_pending_sync(site_id, roost_id, version_id, cancel_event)


class FirebaseClient:
    """
    Main Firebase client for Owlette agent.
    Handles all cloud communication with offline resilience.

    Uses ConnectionManager for centralized connection state management,
    ensuring robust reconnection handling for all failure scenarios.
    """

    def __init__(self, auth_manager: AuthManager, project_id: str, site_id: str, config_cache_path: str = "config/firebase_cache.json"):
        """
        Initialize Firebase client with OAuth authentication.

        Args:
            auth_manager: AuthManager instance for token management
            project_id: Firebase project ID (e.g., "owlette-dev-3838a")
            site_id: Site ID this machine belongs to
            config_cache_path: Path to store cached config for offline mode
        """
        self.auth_manager = auth_manager
        self.project_id = project_id
        self.site_id = site_id
        self.machine_id = shared_utils.get_machine_id()
        self.config_cache_path = config_cache_path

        self.db: Optional[FirestoreRestClient] = None

        self.logger = logging.getLogger("OwletteFirebase")

        # {cmd_id: {'ts': float, 'status': str, 'progress': int|None}} — coalesces
        # chunk progress so a 64k-chunk roost sync isn't 64k firestore writes.
        self._progress_throttle: Dict[str, dict] = {}
        self._progress_throttle_lock = threading.Lock()

        self.connection_manager = ConnectionManager(self.logger)

        self.connection_manager.set_callbacks(
            connect=self._do_connect,
            disconnect=self._do_disconnect,
            on_connected=self._on_connected
        )

        # Thread factories for ConnectionManager supervision
        self.connection_manager.register_thread(
            "command_listener",
            self._create_command_listener_thread
        )
        self.connection_manager.register_thread(
            "config_listener",
            self._create_config_listener_thread
        )

        self.connection_manager.add_state_listener(self._on_connection_state_change)

        # Thread references (managed by ConnectionManager)
        self.metrics_thread: Optional[threading.Thread] = None
        self.running = False

        # Stop events for listener polling threads (set to terminate on reconnect/shutdown)
        self._command_listener_stop: Optional[threading.Event] = None
        self._config_listener_stop: Optional[threading.Event] = None

        self.command_callback: Optional[Callable] = None
        self.config_update_callback: Optional[Callable] = None

        # Slow-command queue (installs/uninstalls/updates — serialised).
        # Worker starts in start(), after self.running = True.
        self._slow_command_queue: queue.Queue = queue.Queue(maxsize=50)
        self._slow_command_worker: Optional[threading.Thread] = None

        # Cached config for offline mode
        self.cached_config: Optional[Dict] = None

        # Track last uploaded config to prevent processing our own writes
        self._last_uploaded_config_hash: Optional[str] = None

        # Instance-level (not a closure local): ConnectionManager restarts the
        # listener thread after a drop, and processed commands must not re-run.
        self._seen_commands: set = set()

        # Killed by cancel_mcp_tool, which already wrote the terminal 'cancelled'
        # entry. _execute_command checks this set as the dead subprocess's thread
        # unwinds, so it re-asserts 'cancelled' instead of clobbering it.
        self._cancelled_commands: set = set()

        # Site metadata: fetched per connect and refreshed every 900s from the
        # metrics thread. site_timezone drives PROCESS schedule evaluation and is
        # non-None only while the site opts in (schedulesFollowSiteTime) — the
        # server decides, the agent mirrors. site_name is the operator label
        # published via tmp/service_status.json. None when unreadable/opted out —
        # consumers fall back to the site id and to each machine's local clock.
        self.site_timezone: Optional[str] = None
        self.site_name: Optional[str] = None
        # A denial never changes for this client's life: log once, stop asking.
        # Cleared by construction (_initialize_or_restart_firebase_client).
        self._site_metadata_denied: bool = False
        # Silences the log only, never the retry: the route may just not be
        # deployed at this agent's api_base yet.
        self._site_metadata_api_warned: bool = False

        # Track last synced software inventory hash to prevent unnecessary writes
        self._last_software_inventory_hash: Optional[str] = None

        # Wall-clock secs of the last landed heartbeat write (presence or metrics
        # — both carry lastHeartbeat); 0.0 until one lands.
        self._last_heartbeat_time: float = 0.0

        # Hardware profile state (schemaVersion 1). _last_profile_check is
        # monotonic secs; _cached_profile_hash is lazily read from
        # profile_hash.json; _last_primary feeds compute_primary hysteresis.
        self._last_profile_check: float = 0.0
        self._cached_profile: Optional[Dict] = None
        self._cached_profile_hash: Optional[str] = None
        self._last_primary: Optional[Dict] = None
        self._profile_hash_path: str = shared_utils.get_data_path('tmp/profile_hash.json')

        # Buffers alerts whose fire-and-forget POST failed; drained by the
        # connection-state listener on the next CONNECTED. In-memory only (a
        # restart wipes it); capped at 100, oldest dropped first.
        self._pending_alerts: list = []
        self._pending_alerts_lock = threading.Lock()
        self._PENDING_ALERTS_MAX = 100

        # Display profile state (schemaVersion 1). Same shape as the hardware
        # cache: rate-limited rebuild, signature-hashed upload, hash persisted on
        # disk. Writes go to hardware/display only — never online/lastHeartbeat.
        self._last_display_check: float = 0.0
        self._cached_display_profile: Optional[Dict] = None
        self._cached_display_hash: Optional[str] = None
        self._display_hash_path: str = shared_utils.get_data_path('.display_profile_hash')

        # Display-modes catalogue: on-demand only (dashboard sends
        # enumerate_display_modes when the editor opens). signatureHash matches the
        # display profile's, so unchanged topology is a no-op upload; separate hash
        # file so either cache can be invalidated alone.
        self._cached_display_modes_hash: Optional[str] = None
        self._display_modes_hash_path: str = shared_utils.get_data_path('.display_modes_hash')

        self._load_cached_config()
        self.connection_manager.connect()

    # Connection Manager Callbacks

    def _do_connect(self) -> bool:
        """
        Called by ConnectionManager to establish connection.

        Returns:
            True if connection succeeded, False otherwise.
        """
        try:
            # Check if authenticated
            if not self.auth_manager.is_authenticated():
                self.logger.error("Agent not authenticated - no refresh token found")
                self.logger.warning("Running in OFFLINE MODE - will use cached config only")
                return False

            # Validate token before creating client
            try:
                self.auth_manager.get_valid_token()
            except (AuthenticationError, TokenRefreshError) as e:
                self.logger.error(f"Token validation failed: {e}")
                return False

            # Safety belt: close any lingering client from a prior connect
            # that didn't go through _do_disconnect (shouldn't happen, but
            # guarantees we never stack two live HTTP sessions).
            old_db = getattr(self, 'db', None)
            if old_db is not None:
                try:
                    old_db.close()
                except Exception as e:
                    self.logger.debug(f"Old Firestore client close failed (ignored): {e}")

            # Initialize Firestore REST client
            self.db = FirestoreRestClient(
                project_id=self.project_id,
                auth_manager=self.auth_manager
            )

            self.logger.info(f"Firestore initialized - Site: {self.site_id}, Machine: {self.machine_id}")
            return True

        except Exception as e:
            self.logger.error(f"Failed to initialize Firebase: {e}")
            return False

    def _do_disconnect(self):
        """Release the REST client's HTTP session pool so reconnect cycles don't
        leak sockets. No-op if already disconnected."""
        self.logger.debug("Disconnect callback: cleaning up resources")
        db = getattr(self, 'db', None)
        if db is not None:
            try:
                db.close()
            except Exception as e:
                self.logger.debug(f"Firestore client close failed (ignored): {e}")
            self.db = None

    def _on_connected(self):
        """
        Called by ConnectionManager after successful connection/reconnection.
        Performs initial data sync.
        """
        if not self.running:
            return  # Don't send data if not started

        try:
            # PRESENCE FIRST — it needs no hardware data. Everything below is a
            # round trip or (in _ensure_profile) tens of seconds of WMI and
            # sensor work, so this keeps time-to-online = connect time. Mirrored
            # in start(); do not reorder.
            self._update_presence(True)
            self.logger.debug("Heartbeat sent after connection")

            self._fetch_site_metadata()

            # INVARIANT: profile upload precedes the first metrics write (only
            # presence may go earlier), else metrics cite a stale profileHash.
            self._ensure_profile()

            metrics = shared_utils.get_system_metrics()
            self._upload_metrics(metrics)
            self.logger.debug("Initial metrics uploaded after connection")
        except Exception as e:
            self.logger.error(f"Failed to send initial data after connection: {e}")
            # Connection is still valid — report, don't fail
            self.connection_manager.report_error(e, "Initial data upload")

    def _on_connection_state_change(self, event: ConnectionEvent):
        """
        React to connection state changes.

        Args:
            event: ConnectionEvent with old_state, new_state, reason
        """
        if event.new_state == ConnectionState.FATAL_ERROR:
            self._handle_fatal_error(event.reason)
        elif event.new_state == ConnectionState.CONNECTED:
            # Daemon thread: a slow drain must not block the state listener,
            # which every other listener queues behind.
            self._drain_pending_alerts_async()

    def _handle_fatal_error(self, reason: str):
        """
        Handle fatal connection errors (e.g., machine removed from site).

        Args:
            reason: Reason for the fatal error
        """
        self.logger.error(f"Fatal connection error: {reason}")

        reason_lower = reason.lower()
        if any(x in reason_lower for x in ['403', '404', 'permission', 'not found']):
            self.logger.warning("Machine may have been removed from site via web dashboard")
            self.logger.info("Disabling Firebase and clearing site_id in local config")

            try:
                config = shared_utils.read_config()

                if 'firebase' not in config:
                    config['firebase'] = {}

                config['firebase']['enabled'] = False
                config['firebase']['site_id'] = ''

                shared_utils.save_config(config)
                self.logger.info("Local config updated - machine deregistered from site")

            except Exception as config_error:
                self.logger.error(f"Failed to update local config after removal detection: {config_error}")

    # Thread Factories (for ConnectionManager supervision)

    def _create_command_listener_thread(self) -> threading.Thread:
        """Factory for creating command listener thread."""
        return threading.Thread(target=self._command_listener_loop, daemon=True)

    def _create_config_listener_thread(self) -> threading.Thread:
        """Factory for creating config listener thread."""
        return threading.Thread(target=self._config_listener_loop, daemon=True)

    # Site Metadata

    def _fetch_site_metadata(self):
        """Cache the site's display name and its schedule timezone.

        1. ``GET /api/agent/site`` — name + timezone; the path that works today.
        2. Direct read of ``sites/{siteId}`` — firestore.rules scopes agents to
           their machine subtree, so it 403s; kept wired for a future rule grant.

        Runs on connect/reconnect and every 900s from the metrics thread (never
        the 5s main loop — this is a network round trip). Both values are optional
        and a failed lookup keeps the previous cache; callers fall back to the
        site id and to each machine's local clock.
        """
        if self._fetch_site_metadata_from_api():
            return
        self._fetch_site_metadata_from_firestore()

    def get_site_metadata(self) -> Optional[dict]:
        """GET /agent/site — the server-mediated projection of `sites/{siteId}`.

        The ONLY request site for it. Returns the parsed payload, or None if the
        API did not answer with 200.

        Agents cannot read `sites/{siteId}` directly (firestore.rules scopes them
        to their machine subtree), which is why this route exists at all. The
        roost kill switch reads `roostEnabled` from here for the same reason.
        """
        try:
            token = self.auth_manager.get_valid_token()
            api_base = shared_utils.get_api_base_url()
            import requests
            response = requests.get(
                f"{api_base}/agent/site",
                headers={'Authorization': f'Bearer {token}'},
                timeout=10,
            )
            if response.status_code != 200:
                self._warn_site_metadata_api_once(
                    f"HTTP {response.status_code} from {api_base}/agent/site"
                )
                return None
            return response.json()
        except Exception as e:
            self._warn_site_metadata_api_once(str(e))
            return None

    def _fetch_site_metadata_from_api(self) -> bool:
        """Resolve the site's display name and schedule timezone through the web API.

        True = the API answered (both values cached, including "the site has
        neither"); False = fall back to the Firestore read.

        The SERVER owns the policy: it returns a `timezone` only when the site's
        `schedulesFollowSiteTime` is true and it has one set, and `null` in every
        other case. The agent never re-derives that, which is why the assignment
        below is unconditional — a site switching the flag back off has to CLEAR
        a cached timezone, not keep evaluating windows against a stale one.
        """
        payload = self.get_site_metadata()
        if payload is None:
            return False
        try:
            name = payload.get('name')
            name = name.strip() if isinstance(name, str) and name.strip() else None
            # Transition-only: the 900s refresh would otherwise repeat this line
            # 96 times a day.
            if name and name != self.site_name:
                self.logger.info(f"Site name: {name}")
            self.site_name = name

            timezone = payload.get('timezone')
            timezone = timezone.strip() if isinstance(timezone, str) and timezone.strip() else None
            self._apply_site_timezone(timezone)
            return True
        except Exception as e:
            self._warn_site_metadata_api_once(str(e))
            return False

    def _apply_site_timezone(self, timezone: Optional[str]):
        """Assign the schedule timezone, logging only the transitions.

        Always assigns — including None, which is how a site that turns
        `schedulesFollowSiteTime` off (or clears its timezone) drops the whole
        fleet back to machine-local windows without a service restart.
        """
        if timezone == self.site_timezone:
            return
        previous = self.site_timezone
        self.site_timezone = timezone
        if timezone:
            self.logger.info(
                f"Process schedules now follow the site's timezone: {timezone}"
                + (f" (was {previous})" if previous else "")
            )
        else:
            self.logger.info(
                f"Process schedules now follow each machine's local clock — "
                f"the site's timezone ({previous}) no longer applies"
            )

    def _warn_site_metadata_api_once(self, detail: str):
        """Log an API site-metadata lookup failure once, then stay quiet.

        Unlike a Firestore denial this does not latch: an undeployed/unreachable
        route is temporary, so every connect and every refresh retries — only the
        noise is muted.
        """
        if self._site_metadata_api_warned:
            self.logger.debug(f"Site metadata lookup failed: {detail}")
            return
        self._site_metadata_api_warned = True
        self.logger.warning(
            f"Could not resolve this site's display name or schedule timezone via "
            f"the API — falling back to the site id and machine-local time: {detail}"
        )

    def _fetch_site_metadata_from_firestore(self):
        """Read `sites/{siteId}` for the name and timezone.

        Agent tokens cannot satisfy the site-document rule today, so this denies
        once per run then no-ops; kept wired so a future rule grant needs no agent
        change.

        Honours the same opt-in as the API path: the timezone applies only when
        `schedulesFollowSiteTime` is exactly true, so this fallback can never turn
        site-time scheduling on for a site that declined it.
        """
        if self._site_metadata_denied:
            return
        try:
            if not self.db:
                return
            site_doc = self.db.get_document(f"sites/{self.site_id}")
            if site_doc:
                follows_site_time = site_doc.get('schedulesFollowSiteTime') is True
                timezone = site_doc.get('timezone') or None
                self._apply_site_timezone(timezone if follows_site_time else None)
                name = site_doc.get('name') or None
                if name and name != self.site_name:
                    self.logger.info(f"Site name: {name}")
                self.site_name = name
        except Exception as e:
            # A denial is an answer, not an outage — warn once (a debug-level
            # swallow hid this for months) and stop asking. Everything else is
            # transient: retry quietly.
            detail = str(e).lower()
            if '403' in detail or 'forbidden' in detail or 'permission' in detail:
                self._site_metadata_denied = True
                self.logger.warning(
                    f"Not permitted to read sites/{self.site_id} — this machine cannot read "
                    f"its site's timezone (the display name comes from the API instead): {e}"
                )
            else:
                self.logger.debug(f"Could not fetch site metadata: {e}")

    # Public Properties

    @property
    def connected(self) -> bool:
        """Check if connected to Firestore (via ConnectionManager)."""
        return self.connection_manager.is_connected

    def is_connected(self) -> bool:
        """Check if connected to Firestore."""
        return self.connection_manager.is_connected

    def get_machine_id(self) -> str:
        """Get the persisted machine identity — this machine's document id."""
        return self.machine_id

    def get_site_id(self) -> str:
        """Get the site ID."""
        return self.site_id

    # Lifecycle Methods

    def start(self):
        """Start all background threads (metrics, command listener, config listener)."""
        if self.running:
            self.logger.warning("Firebase client already running")
            return

        self.running = True

        # Worker needs self.running = True, set above
        self._slow_command_worker = threading.Thread(
            target=self._slow_command_worker_loop,
            name="slow-cmd-worker",
            daemon=True,
        )
        self._slow_command_worker.start()

        self.connection_manager.start_watchdog()

        # ORDER IS LOAD-BEARING: _update_presence needs no hardware data, so it
        # must precede the first _upload_metrics (whose _ensure_profile() does slow
        # WMI and sensor work). Mirrored in _on_connected().
        if self.connected:
            try:
                self._update_presence(True)
                self.logger.info("Initial heartbeat sent - machine is now online")

                # Duplicated from _on_connected because the constructor's connect
                # completes before `running` is True, so _on_connected bailed early
                # and a start that never reconnects would never fetch it.
                # OwletteService reads site_timezone right after start() returns.
                self._fetch_site_metadata()

                metrics = shared_utils.get_system_metrics()
                upload_ok = self._upload_metrics(metrics)
                self.logger.debug("Initial metrics uploaded")

                # Only on a landed write — see _metrics_loop for why.
                if upload_ok:
                    self.connection_manager.report_success()
            except Exception as e:
                self.logger.error(f"Failed to send initial heartbeat/metrics: {e}")
                self.connection_manager.report_error(e, "Initial heartbeat/metrics")

        self.logger.debug("Heartbeat thread DISABLED - heartbeat data included in metrics")

        self.metrics_thread = threading.Thread(target=self._metrics_loop, daemon=True)
        self.metrics_thread.start()
        self.logger.debug("Metrics thread started")

        if self.connected:
            self._seed_seen_commands()
            self.connection_manager._restart_all_threads()
            self.logger.debug("Listener threads started (supervised by ConnectionManager)")

            # Backgrounded: inventory enumeration is slow
            def _sync_inventory_bg():
                try:
                    self._sync_software_inventory(force=True)
                    self.logger.info("Initial software inventory synced to Firestore")
                except Exception as e:
                    self.logger.error(f"Failed to sync initial software inventory: {e}")
            threading.Thread(target=_sync_inventory_bg, daemon=True, name="InventorySync").start()
        else:
            self.logger.warning("Listener threads NOT started (offline mode)")
            self.logger.warning("Software inventory NOT synced (offline mode)")

    def _seed_seen_commands(self):
        """Pre-populate _seen_commands from the completed doc on startup.

        Stops re-execution after a crash between writing "completed" and deleting
        "pending". Entries still status:'running' died with the service, so they
        are marked failed — web pollers need a terminal status, and the id is
        already seeded so it can never re-run.
        """
        try:
            completed_path = f"sites/{self.site_id}/machines/{self.machine_id}/commands/completed"
            completed_data = self.db.get_document(completed_path)
            if completed_data:
                self._seen_commands = set(completed_data.keys())
                self.logger.debug(f"Pre-populated {len(self._seen_commands)} seen commands from completed doc")

                for cmd_id, entry in completed_data.items():
                    if isinstance(entry, dict) and entry.get('status') == 'running':
                        self.logger.warning(f"Command {cmd_id} was interrupted by service restart — marking failed")
                        self._mark_command_failed(
                            cmd_id,
                            'interrupted by service restart',
                            entry.get('deployment_id'),
                            entry.get('type'),
                        )
        except Exception as e:
            self.logger.warning(f"Could not pre-populate seen commands: {e}")

    def enter_shutdown_mode(self, timeout_seconds: float = SHUTDOWN_REQUEST_TIMEOUT):
        """Cap every remaining Firestore request for the shutdown path.

        Windows allows roughly 5s at OS shutdown; the default 30s per request
        outlives that, so one stalled call ate the whole window and the writes
        that record a clean stop never landed.
        """
        try:
            if self.db:
                self.db.set_request_timeout(timeout_seconds)
            self.logger.info(
                f"Firestore request timeout capped at {timeout_seconds}s for shutdown")
        except Exception as e:
            self.logger.debug(f"Could not cap the Firestore request timeout: {e}")

    def stop(self, intentional: bool = False):
        """Stop all background threads and set machine offline.

        Args:
            intentional: agent is exiting to come straight back — tray restart
                (exit 42) or self-restart watchdog (exit 43), both back in ~15s.
                Skips the `online: false` flush that would otherwise flap the
                dashboard and fire an offline alert; heartbeat staleness still
                catches a restart that never returns. False for real stops.
        """
        if intentional:
            self.logger.info("Stopping Firebase client (intentional restart - leaving presence untouched)...")
        else:
            self.logger.info("Stopping Firebase client and setting machine offline...")

        # Offline BEFORE stopping threads, or the write has no transport left.
        if not intentional and self.connected and self.db:
            # Bound outside the try so the failure log below can always read it.
            max_attempts = 3
            try:
                presence_ref = self.db.collection('sites').document(self.site_id)\
                    .collection('machines').document(self.machine_id)

                for attempt in range(max_attempts):
                    try:
                        presence_ref.set({
                            'online': False,
                            'lastHeartbeat': SERVER_TIMESTAMP,
                            'machineId': self.machine_id,
                            'siteId': self.site_id
                        }, merge=True)
                        self.logger.info(f"[OK] Machine marked OFFLINE in Firestore (attempt {attempt + 1}/{max_attempts})")
                        time.sleep(1)
                        break
                    except Exception as e:
                        if attempt == max_attempts - 1:
                            raise
                        self.logger.warning(f"Offline update attempt {attempt + 1} failed, retrying...")
                        time.sleep(0.2)

            except Exception as e:
                self.logger.error(f"[ERROR] Failed to set machine offline after {max_attempts} attempts: {e}")

        # Polling threads first, then the supervised threads that own them
        if self._command_listener_stop is not None:
            self._command_listener_stop.set()
        if self._config_listener_stop is not None:
            self._config_listener_stop.set()

        # Unregister or re-init leaks listeners
        self.connection_manager.remove_state_listener(self._on_connection_state_change)

        self.running = False
        self.connection_manager.shutdown()

        if self._slow_command_worker and self._slow_command_worker.is_alive():
            self._slow_command_worker.join(timeout=5.0)
        if self.metrics_thread and self.metrics_thread.is_alive():
            self.metrics_thread.join(timeout=5.0)

        self.logger.info("Background threads stopped")

    # Main Metrics Loop

    def _metrics_loop(self):
        """
        Upload system stats on an adaptive interval; also drives reconnection.

        5s while the desktop window is open, 30s with processes running, 120s idle.
        """
        self.logger.debug("[THREAD] Metrics loop started")

        last_mode = None
        last_command_cleanup = 0  # epoch seconds — run cleanup on first connected cycle
        # Seeded to now, not 0: connect (start/_on_connected) has just fetched, so
        # the first refresh is due 900s in rather than immediately re-fetching.
        last_site_metadata_refresh = time.time()
        first_loop = True  # Skip initial sleep so first metrics upload happens immediately
        try:
            while self.running:
                interval = 60  # Default interval

                try:
                    if self.connected:
                        try:
                            self.auth_manager.get_valid_token()
                        except Exception as e:
                            self.logger.error(f"Token validation/refresh failed: {e}")
                            self.connection_manager.report_error(e, "Token validation")
                            # Keep this short: idle beat is 120s and the server
                            # calls a machine offline at 300s, so a 60s stall here
                            # ate the whole margin. auth_manager paces the real
                            # retries; this only paces the loop.
                            time.sleep(15)
                            continue

                        # This IS the heartbeat: _upload_metrics writes online +
                        # lastHeartbeat. Keep upload_ok — see report_success below.
                        metrics = shared_utils.get_system_metrics()
                        upload_ok = self._upload_metrics(metrics)

                        # Canonical last_alive refresh; the next startup classifier
                        # measures the "last seen alive" gap from it.
                        try:
                            import session_state
                            session_state.update_alive()
                        except Exception as e:
                            self.logger.debug(f"session_state.update_alive failed in metrics loop: {e}")

                        # ONLY on a landed write: a false success resets the circuit
                        # breaker and watchdog clock, so the agent never reconnects
                        # while the dashboard shows online=true with a frozen
                        # lastHeartbeat.
                        if upload_ok:
                            self.connection_manager.report_success()

                        # "Someone is watching" = desktop main window on screen
                        # (tmp/gui.pid), not process liveness — the app lives in the
                        # tray, so its process outlives the window.
                        window_open = shared_utils.is_desktop_window_open()

                        if window_open:
                            interval = 5
                            mode = 'UI window open'
                        else:
                            processes = metrics.get('processes', {})
                            any_process_active = any(
                                proc.get('status') in ('RUNNING', 'LAUNCHING')
                                for proc in processes.values()
                                if isinstance(proc, dict)
                            )

                            if any_process_active:
                                interval = 30
                                mode = 'processes active'
                            else:
                                interval = 120
                                mode = 'idle'

                        if mode != last_mode:
                            self.logger.info(f"Metrics interval changed to {interval}s ({mode})")
                            last_mode = mode
                        else:
                            self.logger.debug(f"Metrics uploaded - next in {interval}s ({mode})")

                        now = time.time()
                        if now - last_command_cleanup > 600:
                            last_command_cleanup = now
                            try:
                                self._cleanup_stale_commands()
                            except Exception as e:
                                self.logger.debug(f"Command cleanup failed (non-critical): {e}")

                        # A site renaming itself, or opting in/out of site-time
                        # schedules, used to need a reconnect to land. This is a
                        # 10s-timeout HTTP round trip, so it belongs on THIS
                        # thread — never in the 5s main loop, which only reads the
                        # cached attribute.
                        if now - last_site_metadata_refresh > 900:
                            last_site_metadata_refresh = now
                            try:
                                self._fetch_site_metadata()
                            except Exception as e:
                                self.logger.debug(f"Site metadata refresh failed (non-critical): {e}")

                    else:
                        state = self.connection_manager.state
                        reason = self.connection_manager.state_reason
                        self.logger.debug(f"[METRICS] Not connected (state={state.name}): {reason}")

                        if state == ConnectionState.DISCONNECTED:
                            self.logger.debug("[METRICS] Triggering reconnection attempt...")
                            self.connection_manager.force_reconnect("Metrics loop detected disconnect")

                        interval = 30  # poll harder while disconnected

                except Exception as e:
                    self.logger.error(f"Metrics upload failed: {e}")
                    self.connection_manager.report_error(e, "Metrics upload")
                    interval = 60

                # First pass sleeps only long enough for the main service loop to
                # populate process state.
                if first_loop:
                    first_loop = False
                    time.sleep(5)  # Brief wait for process state to populate
                else:
                    time.sleep(interval)

        except Exception as e:
            self.logger.error(f"[THREAD] Metrics loop CRASHED with unexpected error: {e}")
        finally:
            self.logger.error(f"[THREAD] Metrics loop EXITED (running={self.running})")

    # Listener Loops

    def _command_listener_loop(self):
        """Listen for commands from Firestore in real-time."""
        self.logger.debug("[THREAD] Command listener loop started")

        if not self.connected:
            self.logger.warning("[THREAD] Command listener exiting - not connected")
            return

        # Kill a surviving poller or a reconnect double-polls.
        if self._command_listener_stop is not None:
            self._command_listener_stop.set()

        try:
            commands_path = f"sites/{self.site_id}/machines/{self.machine_id}/commands/pending"

            def on_commands_changed(commands_data):
                """Handle commands document changes, skipping already-processed commands."""
                if commands_data:
                    for cmd_id, cmd_data in commands_data.items():
                        if cmd_id in self._seen_commands:
                            continue
                        self._seen_commands.add(cmd_id)
                        self._process_command(cmd_id, cmd_data)

                    gone = self._seen_commands - set(commands_data.keys())
                    self._seen_commands.difference_update(gone)

                    # Cap growth across a long disconnect
                    if len(self._seen_commands) > 1000:
                        self._seen_commands = set(list(self._seen_commands)[-500:])

            _thread, _wake, stop = self.db.listen_to_document(
                commands_path, on_commands_changed,
                min_interval=2.0, max_interval=5.0, backoff_multiplier=1.3
            )
            self._command_listener_stop = stop

            while self.running and self.connected:
                time.sleep(1)

        except Exception as e:
            self.logger.error(f"Command listener error: {e}")
            self.connection_manager.report_error(e, "Command listener")
        finally:
            if self._command_listener_stop is not None:
                self._command_listener_stop.set()
            self.logger.debug(f"[THREAD] Command listener loop EXITED (running={self.running}, connected={self.connected})")

    def _config_listener_loop(self):
        """Listen for config changes from Firestore in real-time."""
        self.logger.debug("[THREAD] Config listener loop started")

        if not self.connected:
            self.logger.warning("[THREAD] Config listener exiting - not connected")
            return

        # Kill a surviving poller or a reconnect double-polls.
        if self._config_listener_stop is not None:
            self._config_listener_stop.set()

        try:
            config_path = f"config/{self.site_id}/machines/{self.machine_id}"

            def on_config_changed(config_data):
                """Handle config document changes."""
                if config_data is not None:
                    incoming_hash = hashlib.md5(json.dumps(config_data, sort_keys=True).encode()).hexdigest()

                    if incoming_hash == self._last_uploaded_config_hash:
                        self.logger.debug(f"Skipping self-originated config change (hash: {incoming_hash[:8]}...)")
                        # One-shot: without clearing, a later change that happens to
                        # hash the same (web reverting a value) is dropped forever.
                        self._last_uploaded_config_hash = None
                        return

                    # Second echo guard, and the one that catches our own
                    # merge:true writes: upload_config hashes the PAYLOAD it
                    # sends while this hashes the doc that comes back, and the
                    # post-write doc is a superset whenever remote-only fields
                    # exist, so the hash above never matches. Agent-originated
                    # writes mirror themselves into the cache, so an echo that
                    # equals the cache carries nothing new. Must be checked
                    # BEFORE the cache is overwritten below.
                    if config_sync.configs_equal(config_data, self.cached_config):
                        self.logger.debug(
                            f"Skipping config echo identical to the cached doc "
                            f"(hash: {incoming_hash[:8]}...)"
                        )
                        return

                    self.logger.info(f"Config change detected in Firestore (hash: {incoming_hash[:8]}...)")

                    self._save_cached_config(config_data)
                    self.cached_config = config_data

                    if self.config_update_callback:
                        try:
                            self.config_update_callback(config_data)
                        except Exception as e:
                            self.logger.error(f"Error in config update callback: {e}")
                            import traceback
                            self.logger.error(f"Traceback: {traceback.format_exc()}")
                    else:
                        self.logger.warning("No config update callback registered")

            _thread, _wake, stop = self.db.listen_to_document(
                config_path, on_config_changed,
                min_interval=2.0, max_interval=10.0, backoff_multiplier=1.3
            )
            self._config_listener_stop = stop

            while self.running and self.connected:
                time.sleep(1)

        except Exception as e:
            self.logger.error(f"Config listener error: {e}")
            self.connection_manager.report_error(e, "Config listener")
        finally:
            if self._config_listener_stop is not None:
                self._config_listener_stop.set()
            self.logger.debug(f"[THREAD] Config listener loop EXITED (running={self.running}, connected={self.connected})")

    # Firestore Operations

    def write_health_to_firestore(self, status: str, error_code, error_message):
        """
        Write agent health to the Firestore machine doc on a health state change.

        No-ops when disconnected; guard with is_connected() if that matters.
        status is 'ok' / 'connection_failure' / etc.
        """
        if not self.connected or not self.db:
            return
        try:
            machine_ref = self.db.collection('sites').document(self.site_id)\
                .collection('machines').document(self.machine_id)

            machine_ref.set({
                'health': {
                    'status': status,
                    'error_code': error_code,
                    'error_message': error_message,
                    'last_checked_at': SERVER_TIMESTAMP,
                    'last_error_at': SERVER_TIMESTAMP if error_code else None,
                }
            }, merge=True)
            self.logger.debug(f"[HEALTH] Wrote health to Firestore: status={status}")
        except Exception as e:
            self.logger.debug(f"[HEALTH] Failed to write health to Firestore: {e}")

    def _update_presence(self, online: bool):
        """Update machine presence/heartbeat in Firestore."""
        if not self.connected or not self.db:
            return

        try:
            presence_ref = self.db.collection('sites').document(self.site_id)\
                .collection('machines').document(self.machine_id)

            presence_ref.set({
                'online': online,
                'lastHeartbeat': SERVER_TIMESTAMP,
                'machineId': self.machine_id,
                'siteId': self.site_id
            }, merge=True)

            if online:
                self._last_heartbeat_time = time.time()
                self.logger.debug("Heartbeat: Machine online")
            else:
                self.logger.info(f"[OK] Machine marked OFFLINE in Firestore (site: {self.site_id}, machine: {self.machine_id})")

        except Exception as e:
            self.logger.error(f"Error updating presence: {e}")
            self.connection_manager.report_error(e, "Presence update")

    # Hardware Profile (schemaVersion 1)

    _PROFILE_CHECK_INTERVAL = 300.0  # seconds between full build_profile() rebuilds
    _DISPLAY_CHECK_INTERVAL = 300.0  # seconds between full build_display_profile() rebuilds

    # update_command_progress throttling: same-status writes inside BOTH
    # thresholds coalesce (per cmd_id). Status changes + force=True write through.
    PROGRESS_THROTTLE_SECONDS = 30.0
    PROGRESS_THROTTLE_PERCENT = 5

    def _load_cached_profile_hash(self) -> Optional[str]:
        """Load the cached profile signature hash from disk (once per process)."""
        if self._cached_profile_hash is not None:
            return self._cached_profile_hash
        try:
            data = shared_utils.read_json_from_file(self._profile_hash_path)
            if isinstance(data, dict):
                hash_val = data.get('signatureHash')
                if isinstance(hash_val, str) and hash_val:
                    self._cached_profile_hash = hash_val
        except Exception as e:
            self.logger.debug(f"No cached profile hash available: {e}")
        return self._cached_profile_hash

    def _write_cached_profile_hash(self, signature_hash: str):
        """Persist the profile signature hash to disk."""
        try:
            os.makedirs(os.path.dirname(self._profile_hash_path), exist_ok=True)
            shared_utils.write_json_to_file({'signatureHash': signature_hash}, self._profile_hash_path)
            self._cached_profile_hash = signature_hash
        except Exception as e:
            self.logger.warning(f"Failed to persist profile hash: {e}")

    def _ensure_profile(self) -> Optional[Dict[str, Any]]:
        """
        Keep sites/{siteId}/machines/{machineId}/hardware/profile current.

        Rebuilds at most once per _PROFILE_CHECK_INTERVAL and only uploads on a
        signature-hash change. Errors are swallowed — heartbeat must never crash.
        Returns the current profile, the cached one when rate-limited, or None.
        """
        now = time.monotonic()
        if self._cached_profile is not None and (now - self._last_profile_check) < self._PROFILE_CHECK_INTERVAL:
            return self._cached_profile

        # Stamp BEFORE build_profile: a persistent failure (stuck WMI, hung
        # disk_usage) must still honour the gate, not retry every heartbeat.
        self._last_profile_check = now

        try:
            profile = hardware_profile.build_profile()
        except Exception as e:
            self.logger.warning(f"build_profile failed: {e}")
            return self._cached_profile

        self._cached_profile = profile

        signature = profile.get('signatureHash')
        if not signature:
            return profile

        cached_hash = self._load_cached_profile_hash()
        if signature == cached_hash:
            return profile

        # Signature changed — upload. Offline: keep cache, retry next tick.
        if not self.connected or not self.db:
            return profile

        try:
            profile_ref = self.db.collection('sites').document(self.site_id)\
                .collection('machines').document(self.machine_id)\
                .collection('hardware').document('profile')
            profile_ref.set(profile, merge=False)
            self._write_cached_profile_hash(signature)
            self.logger.info(f"Hardware profile uploaded (hash={signature[:12]})")
        except Exception as e:
            self.logger.warning(f"Failed to upload hardware profile: {e}")

        return profile

    def _load_cached_display_hash(self) -> Optional[str]:
        """Load the cached display profile signature hash from disk (once per process)."""
        if self._cached_display_hash is not None:
            return self._cached_display_hash
        try:
            data = shared_utils.read_json_from_file(self._display_hash_path)
            if isinstance(data, dict):
                hash_val = data.get('signatureHash')
                if isinstance(hash_val, str) and hash_val:
                    self._cached_display_hash = hash_val
        except Exception as e:
            self.logger.debug(f"No cached display profile hash available: {e}")
        return self._cached_display_hash

    def _write_cached_display_hash(self, signature_hash: str):
        """Persist the display profile signature hash to disk."""
        try:
            os.makedirs(os.path.dirname(self._display_hash_path), exist_ok=True)
            shared_utils.write_json_to_file({'signatureHash': signature_hash}, self._display_hash_path)
            self._cached_display_hash = signature_hash
        except Exception as e:
            self.logger.warning(f"Failed to persist display profile hash: {e}")

    def _load_cached_display_modes_hash(self) -> Optional[str]:
        """Load the display-modes signature hash from disk, once per process."""
        if self._cached_display_modes_hash is not None:
            return self._cached_display_modes_hash
        try:
            data = shared_utils.read_json_from_file(self._display_modes_hash_path)
            if isinstance(data, dict):
                hash_val = data.get('signatureHash')
                if isinstance(hash_val, str) and hash_val:
                    self._cached_display_modes_hash = hash_val
        except Exception as e:
            self.logger.debug(f"No cached display-modes hash available: {e}")
        return self._cached_display_modes_hash

    def _write_cached_display_modes_hash(self, signature_hash: str):
        """Persist the display-modes catalogue signature hash to disk."""
        try:
            os.makedirs(os.path.dirname(self._display_modes_hash_path), exist_ok=True)
            shared_utils.write_json_to_file(
                {'signatureHash': signature_hash}, self._display_modes_hash_path,
            )
            self._cached_display_modes_hash = signature_hash
        except Exception as e:
            self.logger.warning(f"Failed to persist display-modes hash: {e}")

    def _ensure_display_modes_catalogue(self, force: bool = False) -> Dict[str, Any]:
        """Enumerate supported modes per active monitor and upload, skipping when
        ``signatureHash`` is unchanged.

        On-demand only (``enumerate_display_modes``, sent when the layout editor
        opens) — the catalogue changes rarely and only open editors need it.

        Returns a summary dict shaped for the service command handler::

            {
              'ok': True,
              'uploaded': bool,
              'monitorCount': int,
              'modeCount': int,
              'signatureHash': str | None,
              'reason': str | None,  # set when uploaded=False explains why
            }

            or on failure:

            {'ok': False, 'error': str, 'code': DisplayErrorCode}
        """
        import display_manager

        # Kill switch, same check as `_ensure_display_profile`.
        try:
            if shared_utils.read_config(['displays', 'enabled']) is False:
                return {
                    'ok': True,
                    'uploaded': False,
                    'monitorCount': 0,
                    'modeCount': 0,
                    'signatureHash': None,
                    'reason': 'displays_disabled',
                }
        except Exception:
            pass

        result = display_manager.enumerate_modes_via_user_session()
        if not result.get('ok'):
            return result  # helper spawn/timeout/hard failure — pass error + code through

        by_edid = result.get('byEdidHash') or {}
        monitor_count = len(by_edid)
        mode_count = sum(
            len((info or {}).get('modes') or [])
            for info in by_edid.values()
        )
        signature = result.get('signatureHash')

        # Transient CCD stall: skip the upload and keep the cached hash so the next
        # dispatch retries. A hard failure would already have returned ok:False.
        if result.get('enumerationFailed'):
            return {
                'ok': True,
                'uploaded': False,
                'monitorCount': monitor_count,
                'modeCount': mode_count,
                'signatureHash': signature,
                'reason': 'enumeration_failed',
            }

        if not signature:
            return {
                'ok': True,
                'uploaded': False,
                'monitorCount': monitor_count,
                'modeCount': mode_count,
                'signatureHash': None,
                'reason': 'no_signature',
            }

        # Cache-by-hash skip — the whole point of A3.2.
        cached_hash = self._load_cached_display_modes_hash()
        if not force and signature == cached_hash:
            return {
                'ok': True,
                'uploaded': False,
                'monitorCount': monitor_count,
                'modeCount': mode_count,
                'signatureHash': signature,
                'reason': 'unchanged',
            }

        if not self.connected or not self.db:
            return {
                'ok': True,
                'uploaded': False,
                'monitorCount': monitor_count,
                'modeCount': mode_count,
                'signatureHash': signature,
                'reason': 'offline',
            }

        doc = {
            'schemaVersion': result.get('schemaVersion'),
            'signatureHash': signature,
            'capturedAt': result.get('capturedAt'),
            'byEdidHash': by_edid,
        }
        try:
            modes_ref = self.db.collection('sites').document(self.site_id)\
                .collection('machines').document(self.machine_id)\
                .collection('hardware').document('displayModes')
            modes_ref.set(doc, merge=False)
            self._write_cached_display_modes_hash(signature)
            self.logger.info(
                f"Display modes catalogue uploaded "
                f"(hash={signature[:12]}, monitors={monitor_count}, modes={mode_count})"
            )
            return {
                'ok': True,
                'uploaded': True,
                'monitorCount': monitor_count,
                'modeCount': mode_count,
                'signatureHash': signature,
            }
        except Exception as e:
            self.logger.warning(f"Failed to upload display modes catalogue: {e}")
            return {
                'ok': False,
                'error': str(e),
                'code': 'upload_failed',
            }

    def update_display_autorestore_state(self, state_patch: dict) -> None:
        """Patch config/{siteId}/machines/{machineId}.displays.autoRestore.circuitBreaker.

        state_patch keys (all optional, only present keys are written): failures:int,
        tripped:bool (>=3 failures, manual reset only), trippedAt/lastFailureAt/
        lastSuccessAt:iso8601 str, lastError:str (caller truncates to 500).

        Merges into `circuitBreaker` ONLY — siblings under `displays.autoRestore`
        (enabled, enabledBy, enabledAt) are operator-set and must not be clobbered.
        Failures are logged and swallowed; never blocks.
        """
        if not state_patch:
            return

        if not self.connected or not self.db:
            self.logger.debug(
                "Skipping display autoRestore state write — not connected to Firestore"
            )
            return

        try:
            config_ref = self.db.collection('config').document(self.site_id)\
                .collection('machines').document(self.machine_id)
            patch = {
                'displays': {
                    'autoRestore': {
                        'circuitBreaker': state_patch,
                    },
                },
            }
            config_ref.set(patch, merge=True)
            # This is the config doc's second writer. Without mirroring the write
            # into the cache it echoes back through the config listener as a
            # foreign change and pulls the whole doc over config.json, taking any
            # pending local edit with it. config.json gets the same patch because
            # the breaker's own counter is read back off disk — remote, cache and
            # local have to move together or the count never advances.
            self._merge_into_cached_config(patch)
            self._mirror_config_patch_to_disk(patch)
        except Exception as e:
            self.logger.warning(
                f"Failed to update display autoRestore circuit-breaker state: {e}"
            )

    def _ensure_display_profile(self, force: bool = False) -> Optional[Dict[str, Any]]:
        """
        Keep sites/{siteId}/machines/{machineId}/hardware/display current.

        Rebuilds at most once per _DISPLAY_CHECK_INTERVAL (``force=True`` bypasses
        the gate — used by the topology-change detector so the dashboard doesn't
        wait out a 5-minute idle tick), merges NVAPI Mosaic/GSync onto the CCD
        snapshot, uploads only on a signature-hash change. Never touches
        online/lastHeartbeat. Errors are swallowed — heartbeat must not crash.
        Returns the profile, the cached one when rate-limited, or None.
        """
        # Kill switch, checked ahead of the rate-limit gate so a toggle takes
        # effect immediately. Fail-open on unreadable config (first boot).
        try:
            if shared_utils.read_config(['displays', 'enabled']) is False:
                return self._cached_display_profile
        except Exception:
            pass

        # Behind the kill switch and inside a try, like every other lazy
        # display import: the module is Windows-only and never ported, so
        # importing it above the switch takes the heartbeat down elsewhere.
        # Not ImportError - display_manager asserts the Windows x64 ABI while
        # it builds its structures, so off Windows it is an AssertionError.
        try:
            import display_manager
            import nvapi_display
        except Exception as e:
            self.logger.debug(f"Display enumeration is not available here: {e}")
            return self._cached_display_profile

        now = time.monotonic()
        if not force and self._cached_display_profile is not None and (now - self._last_display_check) < self._DISPLAY_CHECK_INTERVAL:
            return self._cached_display_profile

        # Stamp BEFORE build: a persistent failure (stuck CCD, driver hang) must
        # still honour the gate, not retry every heartbeat.
        self._last_display_check = now

        try:
            profile = display_manager.build_display_profile()
        except Exception as e:
            self.logger.warning(f"build_display_profile failed: {e}")
            return self._cached_display_profile

        # Merge NVAPI Mosaic onto the CCD snapshot. mosaicActive is part of the
        # signature identity, but build_display_profile() hashed before this flip
        # — hence the recompute below.
        try:
            mosaic = nvapi_display.detect_mosaic()
            if mosaic:
                profile['mosaicActive'] = True
                profile['mosaicGrids'] = mosaic.get('grids', [])
        except Exception as e:
            self.logger.debug(f"detect_mosaic failed: {e}")

        try:
            sync = nvapi_display.detect_sync()
            if sync:
                profile['syncDevices'] = sync.get('devices', [])
        except Exception as e:
            self.logger.debug(f"detect_sync failed: {e}")

        # Recompute so a mosaicActive flip re-uploads even on an identical layout.
        try:
            profile['signatureHash'] = display_manager.display_signature(profile)
        except Exception as e:
            self.logger.warning(f"display_signature failed: {e}")

        self._cached_display_profile = profile

        # Failed CCD enumeration yields a placeholder with no monitors; uploading
        # it would clobber good Firestore data. Keep the cache, retry next tick.
        if profile.get('enumerationFailed'):
            self.logger.debug("Skipping display profile upload: enumeration failed")
            return self._cached_display_profile

        signature = profile.get('signatureHash')
        if not signature:
            return profile

        cached_hash = self._load_cached_display_hash()
        if signature == cached_hash:
            return profile

        # Signature changed — upload. Offline: keep cache, retry next tick.
        if not self.connected or not self.db:
            return profile

        try:
            profile_ref = self.db.collection('sites').document(self.site_id)\
                .collection('machines').document(self.machine_id)\
                .collection('hardware').document('display')
            profile_ref.set(profile, merge=False)
            self._write_cached_display_hash(signature)
            self.logger.info(f"Display profile uploaded (hash={signature[:12]})")
        except Exception as e:
            self.logger.warning(f"Failed to upload display profile: {e}")

        return profile

    def _upload_metrics(self, metrics: Dict[str, Any]) -> bool:
        """Upload system metrics to Firestore.

        The `metrics` argument provides the lean in-line dict from
        shared_utils.get_system_metrics_with_config (memory + processes).
        Dynamic hardware metrics (cpus/disks/gpus/nics/network) are collected
        here from the current hardware_profile so the shape stays aligned with
        the uploaded schemaVersion 1 profile document.

        Returns True if the heartbeat/metrics write landed, False otherwise.
        This IS the periodic heartbeat (it writes `online` + `lastHeartbeat`), so
        callers MUST NOT report connection success when it returns False — doing
        so resets the circuit breaker and the self-restart watchdog's "last
        success" clock, which would leave a machine sitting online=true with a
        frozen heartbeat and never reconnecting.
        """
        if not self.connected or not self.db:
            return False

        metrics_ref = self.db.collection('sites').document(self.site_id)\
            .collection('machines').document(self.machine_id)

        try:
            # Must precede the dynamic metrics below — they key off profile IDs.
            profile = self._ensure_profile()

            # Writes hardware/display only; guarded so display failures can never
            # break the metrics upload.
            try:
                self._ensure_display_profile()
            except Exception as e:
                self.logger.warning(f"_ensure_display_profile failed: {e}")

            try:
                dynamic = hardware_profile.collect_dynamic_metrics(profile) if profile else {}
            except Exception as e:
                self.logger.warning(f"collect_dynamic_metrics failed: {e}")
                dynamic = {}

            # Hysteresis against the previous tick.
            try:
                primary = hardware_profile.compute_primary(dynamic, self._last_primary)
                self._last_primary = primary
            except Exception as e:
                self.logger.warning(f"compute_primary failed: {e}")
                primary = self._last_primary or {'cpu': None, 'disk': None, 'gpu': None, 'nic': None}

            memory_data = metrics.get('memory', {})
            processes_data = metrics.get('processes', {})

            self.logger.debug(f"Uploading metrics with {len(processes_data)} processes: {list(processes_data.keys())}")

            profile_hash = profile.get('signatureHash') if profile else None

            # On every heartbeat so list/card views can draw the drift dot without
            # each opening its own assigned-layout subscription.
            try:
                import display_manager

                live_monitors = (
                    self._cached_display_profile.get('monitors')
                    if isinstance(self._cached_display_profile, dict) else None
                )
                assigned_monitors = shared_utils.read_config(
                    ['displays', 'assigned', 'monitors']
                )
                display_drift_count = display_manager.compute_drift_count(
                    live_monitors, assigned_monitors
                )
            except Exception as e:
                self.logger.debug(f"compute_drift_count failed: {e}")
                display_drift_count = 0

            # update() + dot notation REPLACES nested maps rather than deep-merging,
            # so deleted processes/devices don't linger as ghost entries.
            metrics_ref.update({
                'online': True,
                'lastHeartbeat': SERVER_TIMESTAMP,
                'agent_version': shared_utils.APP_VERSION,
                'machine_timezone': shared_utils.get_machine_timezone(),
                'machine_timezone_iana': shared_utils.get_machine_timezone_iana(),
                'machineId': self.machine_id,
                'siteId': self.site_id,
                # Capability handshake: the dashboard disables remote apply when
                # this is missing or < 1. Bump on helper IPC contract changes only
                # — unrelated to agent_version.
                'capabilities.displayRemoteApply': 1,
                'metrics.schemaVersion': 2,
                'metrics.profileHash': profile_hash,
                'metrics.timestamp': SERVER_TIMESTAMP,
                'metrics.cpus': dynamic.get('cpus', {}),
                'metrics.disks': dynamic.get('disks', {}),
                'metrics.diskio': dynamic.get('diskio', {}),
                'metrics.gpus': dynamic.get('gpus', {}),
                'metrics.nics': dynamic.get('nics', {}),
                'metrics.memory': memory_data,
                'metrics.network': dynamic.get('network', {}),
                'metrics.primary': primary,
                'metrics.processes': processes_data,
                'metrics.displayDriftCount': display_drift_count,
                # Drop legacy v1 singulars alongside the v2 plurals; DELETE_FIELD
                # no-ops on fresh docs.
                'metrics.cpu': DELETE_FIELD,
                'metrics.disk': DELETE_FIELD,
                'metrics.gpu': DELETE_FIELD,
            })

            self._last_heartbeat_time = time.time()
            return True

        except Exception as e:
            self.logger.error(f"Error uploading metrics: {e}")
            self.connection_manager.report_error(e, "Metrics upload")
            return False

    # Fast (<30s) and concurrency-safe. The two cancel_* interrupts MUST stay on
    # this lane or they serialise behind the work they are meant to stop (OWL-06).
    # Heavy roost work (sync_pull, rollback) stays on the slow lane.
    _FAST_COMMAND_TYPES = frozenset({'mcp_tool_call', 'capture_screenshot', 'cancel_sync', 'cancel_mcp_tool'})

    def _process_command(self, cmd_id: str, cmd_data: Dict[str, Any]):
        """Dispatch a command to its execution lane.

        Everything runs off-thread so the polling callback never blocks. Fast
        commands get a thread each; slow ones (installs/uninstalls/updates) go
        through a single worker so installs can't overlap.
        """
        cmd_type = cmd_data.get('type')

        if cmd_type in self._FAST_COMMAND_TYPES:
            t = threading.Thread(
                target=self._execute_command,
                args=(cmd_id, cmd_data),
                name=f"fast-cmd-{cmd_id[:20]}",
                daemon=True,
            )
            t.start()
        else:
            pending_sync_cancel = _register_pending_sync_cancel(cmd_data)
            try:
                self._slow_command_queue.put_nowait((cmd_id, cmd_data))
            except queue.Full:
                _discard_pending_sync_cancel(pending_sync_cancel)
                self.logger.warning(f"Slow command queue full, rejecting command {cmd_id}")
                self._mark_command_failed(cmd_id, "Command queue full — too many pending installs", cmd_data.get('deployment_id'), cmd_data.get('type'))
            except Exception:
                _discard_pending_sync_cancel(pending_sync_cancel)
                raise

    def _execute_command(self, cmd_id: str, cmd_data: Dict[str, Any]):
        """Execute a command and write the result to Firestore."""
        try:
            cmd_type = cmd_data.get('type')
            self.logger.info(f"Processing command: {cmd_id} - Type: {cmd_type}")

            deployment_id = cmd_data.get('deployment_id')

            # In-flight marker for restart safety: _seed_seen_commands turns a
            # surviving status:'running' into a failure rather than re-running it,
            # and web pollers treat 'running' as non-terminal. deployment_id/type
            # must be threaded in — the deploymentStatus function skips markers
            # without a deployment_id, stranding it 'in_progress'.
            self._mark_command_running(cmd_id, deployment_id, cmd_type)

            if cmd_type == 'cancel_mcp_tool':
                # Client-side interrupt, no service callback.
                result = self._handle_cancel_mcp_tool(cmd_data)
                self._mark_command_completed(cmd_id, result, deployment_id, cmd_type)
                return

            if self.command_callback:
                result = self.command_callback(cmd_id, cmd_data)

                if result is COMMAND_DEFERRED:
                    # The handler's own thread is still working and owns the
                    # terminal write; marking the command here would put a
                    # completed status in front of the progress that follows.
                    return

                self.finish_command(cmd_id, cmd_data, result)
            else:
                self.logger.warning(f"No command callback registered, ignoring command {cmd_id}")

        except Exception as e:
            self.logger.error(f"Error processing command {cmd_id}: {e}")
            if cmd_id in self._cancelled_commands:
                # A cancelled subprocess can raise while unwinding — keep the
                # terminal status truthful.
                self._cancelled_commands.discard(cmd_id)
                self._mark_command_cancelled(cmd_id, 'cancelled by user', cmd_data.get('deployment_id'), cmd_data.get('type'))
            else:
                self._mark_command_failed(cmd_id, str(e), cmd_data.get('deployment_id'), cmd_data.get('type'))
            cmd_type = cmd_data.get('type')
            dep_id = cmd_data.get('deployment_id')
            if cmd_type in ('install_software', 'uninstall_software', 'update_owlette') and dep_id:
                software_name = cmd_data.get('installer_name') or cmd_data.get('software_name') or cmd_type
                self.log_event('deployment_failed', 'error', software_name,
                               f"Deployment {dep_id} failed: {e}")

    def finish_command(self, cmd_id: str, cmd_data: Dict[str, Any], result: Any):
        """Write a command's terminal status, its audit row and a fresh metric.

        The end of _execute_command, reachable on its own so a handler that
        returned COMMAND_DEFERRED can call it from the thread that finishes the
        work - the self-update off Windows, which hands the install to the init
        system minutes after the lane was released.
        """
        cmd_type = cmd_data.get('type')
        deployment_id = cmd_data.get('deployment_id')
        is_error = isinstance(result, str) and result.startswith("Error:")

        if cmd_id in self._cancelled_commands:
            # cancel_mcp_tool already wrote the terminal 'cancelled' entry
            # — re-assert it, don't clobber it with the dead subprocess's
            # completed/failed result.
            self._cancelled_commands.discard(cmd_id)
            self._mark_command_cancelled(cmd_id, 'cancelled by user', deployment_id, cmd_type)
        elif cmd_type == 'cancel_installation':
            self._mark_command_cancelled(cmd_id, result, deployment_id, cmd_type)
        elif is_error:
            self._mark_command_failed(cmd_id, result, deployment_id, cmd_type)
        else:
            self._mark_command_completed(cmd_id, result, deployment_id, cmd_type)

        # Deployment lifecycle → site logs (audit trail)
        deployment_cmd_types = ('install_software', 'uninstall_software', 'update_owlette')
        if cmd_type in deployment_cmd_types and deployment_id:
            software_name = cmd_data.get('installer_name') or cmd_data.get('software_name') or cmd_type
            if cmd_type == 'cancel_installation':
                self.log_event('deployment_cancelled', 'warning', software_name,
                               f"Deployment {deployment_id} cancelled: {result}")
            elif is_error:
                self.log_event('deployment_failed', 'error', software_name,
                               f"Deployment {deployment_id} failed: {result}")
            else:
                self.log_event('deployment_completed', 'info', software_name,
                               f"Deployment {deployment_id}: {result}")

        # Push metrics now so the dashboard reflects the state change
        try:
            metrics = shared_utils.get_system_metrics()
            self._upload_metrics(metrics)
            self.logger.debug(f"Immediate metrics push after command {cmd_id}")
        except Exception as me:
            self.logger.warning(f"Post-command metrics push failed: {me}")

    def _handle_cancel_mcp_tool(self, cmd_data: Dict[str, Any]) -> str:
        """Cancel an in-flight mcp_tool_call subprocess (Cortex cancel button).

        Kills the target's process tree via mcp_tools' registry, then writes its
        terminal 'cancelled' entry so web pollers resolve the tool card without
        waiting for the killed thread to unwind. Idempotent: an unknown or
        finished target returns an error, never raises.

        Returns a JSON string, per the mcp_tool_call result convention.
        """
        import mcp_tools

        # executeMachineCommand spreads the payload at the TOP LEVEL of the command
        # doc, like every other command; `params` is only a defensive fallback.
        params = cmd_data.get('params') or {}
        target_id = cmd_data.get('target_command_id') or params.get('target_command_id')
        if not target_id:
            return json.dumps({'error': 'target_command_id is required'})

        # Flag BEFORE the kill: the target's thread unblocks from communicate() the
        # instant the tree dies and races _execute_command's guard, so it must see
        # the flag or it writes a partial-output 'completed'. Accepted reverse race:
        # a command finishing naturally in that window is marked cancelled anyway.
        self._cancelled_commands.add(target_id)

        if not mcp_tools.cancel_running_command(target_id):
            self._cancelled_commands.discard(target_id)
            return json.dumps({'error': 'command not running'})

        if self.connected and self.db:
            try:
                completed_ref = self.db.collection('sites').document(self.site_id)\
                    .collection('machines').document(self.machine_id)\
                    .collection('commands').document('completed')

                completed_ref.set({
                    target_id: {
                        'status': 'cancelled',
                        'error': 'cancelled by user',
                        'completedAt': SERVER_TIMESTAMP,
                    }
                }, merge=True)
            except Exception as e:
                self.logger.error(f"Failed to write cancelled status for command {target_id}: {e}")

        self.logger.info(f"Command {target_id} cancelled by user — process tree killed")
        return json.dumps({'status': 'cancelled', 'target_command_id': target_id})

    def _slow_command_worker_loop(self):
        """Drain the slow-command queue one at a time (serialised installs)."""
        while self.running:
            try:
                cmd_id, cmd_data = self._slow_command_queue.get(timeout=2.0)
            except queue.Empty:
                continue
            try:
                self._execute_command(cmd_id, cmd_data)
            except Exception as e:
                self.logger.error(f"Slow command worker error: {e}")
            finally:
                self._slow_command_queue.task_done()

    def update_command_progress(self, cmd_id: str, status: str, deployment_id: Optional[str] = None, progress: Optional[int] = None, force: bool = False):
        """
        Report intermediate command progress (downloading, installing, ...).

        Args:
            status: e.g. 'downloading', 'installing'
            progress: percent, 0-100
            force: bypass throttling for writes that MUST land — dropping the final
                   100% is what leaves the UI stuck at 95%.

        Per-cmd_id writes coalesce to "every 5% or every 30s, whichever first" so a
        64k-chunk distribution doesn't explode firestore cost. Status changes always
        write through; only same-status progress updates throttle.
        """
        if not self.connected or not self.db:
            return

        should_emit, new_state = should_emit_progress(
            prev_state=self._progress_throttle.get(cmd_id),
            status=status,
            progress=progress,
            force=force,
            now=time.time(),
            min_seconds=self.PROGRESS_THROTTLE_SECONDS,
            min_pct=self.PROGRESS_THROTTLE_PERCENT,
        )
        if not should_emit:
            return
        with self._progress_throttle_lock:
            self._progress_throttle[cmd_id] = new_state

        try:
            completed_ref = self.db.collection('sites').document(self.site_id)\
                .collection('machines').document(self.machine_id)\
                .collection('commands').document('completed')

            progress_data = {
                'status': status,
                'updatedAt': SERVER_TIMESTAMP
            }

            if deployment_id:
                progress_data['deployment_id'] = deployment_id

            if progress is not None:
                progress_data['progress'] = progress

            completed_ref.set({
                cmd_id: progress_data
            }, merge=True)

            self.logger.debug(f"Command {cmd_id} progress: {status}" + (f" ({progress}%)" if progress is not None else ""))

        except Exception as e:
            self.logger.error(f"Failed to update command {cmd_id} progress: {e}")

    def _mark_command_running(self, cmd_id: str, deployment_id: Optional[str] = None, cmd_type: Optional[str] = None):
        """Write a status:'running' marker to the completed doc (restart safety).

        _seed_seen_commands turns a surviving marker into a failure rather than
        re-running the command; the terminal _mark_command_* write overwrites it.
        Web pollers treat 'running' as non-terminal.

        deployment_id/cmd_type must be threaded in: deploymentStatus skips entries
        without a deployment_id (`if (!deployment_id) continue`), leaving the
        deployment 'in_progress' forever.
        """
        if not self.connected or not self.db:
            return

        try:
            completed_ref = self.db.collection('sites').document(self.site_id)\
                .collection('machines').document(self.machine_id)\
                .collection('commands').document('completed')

            running_data = {
                'status': 'running',
                'startedAt': SERVER_TIMESTAMP,
            }

            if deployment_id:
                running_data['deployment_id'] = deployment_id

            if cmd_type:
                running_data['type'] = cmd_type

            completed_ref.set({
                cmd_id: running_data
            }, merge=True)

        except Exception as e:
            self.logger.warning(f"Failed to mark command {cmd_id} as running: {e}")

    def _mark_command_terminal(self, cmd_id: str, status: str, field: str, value: Any,
                               deployment_id: Optional[str], cmd_type: Optional[str],
                               log_line: str, log_as_error: bool = False):
        """Write a command's terminal status and drop it from pending.

        Shared body for _mark_command_completed / _mark_command_failed /
        _mark_command_cancelled, which differ only in the payload field, the
        status literal and the log line.
        """
        if not self.connected or not self.db:
            return

        try:
            completed_ref = self.db.collection('sites').document(self.site_id)\
                .collection('machines').document(self.machine_id)\
                .collection('commands').document('completed')

            completed_data = {
                field: value,
                'status': status,
                'completedAt': SERVER_TIMESTAMP
            }

            if deployment_id:
                completed_data['deployment_id'] = deployment_id

            if cmd_type:
                completed_data['type'] = cmd_type

            # completed FIRST: on failure the command stays in pending (retryable);
            # the reverse order can lose it entirely.
            completed_ref.set({
                cmd_id: completed_data
            }, merge=True)

            pending_ref = self.db.collection('sites').document(self.site_id)\
                .collection('machines').document(self.machine_id)\
                .collection('commands').document('pending')

            pending_ref.update({
                cmd_id: DELETE_FIELD
            })

            (self.logger.error if log_as_error else self.logger.info)(log_line)

        except Exception as e:
            self.logger.error(f"Failed to mark command {cmd_id} as {status}: {e}")

    def _mark_command_completed(self, cmd_id: str, result: Any, deployment_id: Optional[str] = None, cmd_type: Optional[str] = None):
        """Mark a command as completed in Firestore."""
        self._mark_command_terminal(cmd_id, 'completed', 'result', result, deployment_id, cmd_type,
                                    f"Command {cmd_id} marked as completed")

    def _mark_command_failed(self, cmd_id: str, error: str, deployment_id: Optional[str] = None, cmd_type: Optional[str] = None):
        """Mark a command as failed in Firestore."""
        self._mark_command_terminal(cmd_id, 'failed', 'error', error, deployment_id, cmd_type,
                                    f"Command {cmd_id} marked as failed: {error}", log_as_error=True)

    def _mark_command_cancelled(self, cmd_id: str, result: str, deployment_id: Optional[str] = None, cmd_type: Optional[str] = None):
        """Mark a command as cancelled in Firestore."""
        self._mark_command_terminal(cmd_id, 'cancelled', 'result', result, deployment_id, cmd_type,
                                    f"Command {cmd_id} marked as cancelled")

    def _cleanup_stale_commands(self):
        """Remove stale pending commands (>1h) and old completed commands (>24h).

        Runs periodically from the metrics loop. Non-critical — failures are
        logged at debug level and silently ignored.
        """
        if not self.connected or not self.db:
            return

        now_ms = int(time.time() * 1000)
        pending_ttl_ms = 60 * 60 * 1000         # 1 hour
        completed_ttl_ms = 24 * 60 * 60 * 1000  # 24 hours

        base = f"sites/{self.site_id}/machines/{self.machine_id}/commands"

        pending_data = self.db.get_document(f"{base}/pending", _suppress_logging=True)
        if pending_data:
            stale_pending = []
            for cmd_id, cmd in pending_data.items():
                if not isinstance(cmd, dict):
                    continue
                ts_ms = timestamp_to_ms(cmd.get('timestamp'))
                if ts_ms > 0 and (now_ms - ts_ms) > pending_ttl_ms:
                    stale_pending.append(cmd_id)
            if stale_pending:
                pending_ref = self.db.collection('sites').document(self.site_id)\
                    .collection('machines').document(self.machine_id)\
                    .collection('commands').document('pending')
                # Chunked: REST API URL length limit
                for i in range(0, len(stale_pending), 50):
                    chunk = stale_pending[i:i + 50]
                    pending_ref.update({cmd_id: DELETE_FIELD for cmd_id in chunk})
                self._seen_commands.difference_update(stale_pending)
                self.logger.info(f"Cleaned {len(stale_pending)} stale pending command(s)")

        completed_data = self.db.get_document(f"{base}/completed", _suppress_logging=True)
        if completed_data:
            old_completed = []
            for cmd_id, cmd in completed_data.items():
                if not isinstance(cmd, dict):
                    continue
                # completedAt on finished commands, startedAt on running markers.
                ts_ms = timestamp_to_ms(cmd.get('completedAt') or cmd.get('startedAt') or cmd.get('timestamp'))
                if ts_ms > 0 and (now_ms - ts_ms) > completed_ttl_ms:
                    old_completed.append(cmd_id)
            if old_completed:
                completed_ref = self.db.collection('sites').document(self.site_id)\
                    .collection('machines').document(self.machine_id)\
                    .collection('commands').document('completed')
                # Chunked: REST API URL length limit
                for i in range(0, len(old_completed), 50):
                    chunk = old_completed[i:i + 50]
                    completed_ref.update({cmd_id: DELETE_FIELD for cmd_id in chunk})
                self._seen_commands.difference_update(old_completed)
                self.logger.info(f"Cleaned {len(old_completed)} old completed command(s)")

    # Configuration

    def get_config(self, raise_on_error: bool = False) -> Optional[Dict]:
        """
        Get machine configuration from Firestore (or cache if offline).

        Args:
            raise_on_error: propagate a failed fetch instead of falling back to
                the cache. Startup reconciliation needs this: a returned None
                otherwise reads as "no document exists" and seeds installer
                defaults over a live one on a transient 5xx.

        Returns:
            Configuration dict or None if not available
        """
        if self.connected and self.db:
            try:
                config_ref = self.db.collection('config').document(self.site_id)\
                    .collection('machines').document(self.machine_id)

                config = config_ref.get()
                if config:
                    self._save_cached_config(config)
                    self.cached_config = config
                    return config
            except Exception as e:
                self.logger.error(f"Failed to get config from Firestore: {e}")
                self.connection_manager.report_error(e, "Get config")
                if raise_on_error:
                    raise

        if self.cached_config:
            self.logger.info("Using cached config (offline mode)")
            return self.cached_config

        return None

    def upload_config(self, config: Dict):
        """
        Upload local config to Firestore.
        Used for initial migration from local config.json.

        Args:
            config: Configuration dict to upload
        """
        if not self.connected or not self.db:
            self.logger.warning("Cannot upload config - not connected to Firestore")
            return

        try:
            config_ref = self.db.collection('config').document(self.site_id)\
                .collection('machines').document(self.machine_id)

            # Hash BEFORE the write, or the listener thread can fire in the gap
            # between write and hash and loop on our own change.
            config_hash = hashlib.md5(json.dumps(config, sort_keys=True).encode()).hexdigest()
            self._last_uploaded_config_hash = config_hash

            config_ref.set(config, merge=True)

            self.logger.info(f"Config uploaded to Firestore successfully (hash: {config_hash[:8]}...)")

            self._save_cached_config(config)
            self.cached_config = config

        except Exception as e:
            # Write failed — clear, or a later legitimate change is suppressed.
            self._last_uploaded_config_hash = None
            self.logger.error(f"Failed to upload config to Firestore: {e}")
            self.connection_manager.report_error(e, "Upload config")

    def push_local_config(self, local_config: Dict, reason: str = 'local change') -> bool:
        """Upload a locally-originated config edit and re-anchor the echo guard.

        Nothing has uploaded local edits since the Tkinter GUI was removed in
        3.0.0, so an edit made on the machine survived only until the next pull.

        The re-read afterwards is what makes the echo guard work: upload_config
        hashes the PAYLOAD it sends, but the listener hashes the document it
        receives, and with merge=True the post-write document is a superset
        whenever remote-only fields exist. Anchoring the hash and the cache on
        the document Firestore actually holds means the echo is recognised.

        That anchoring is also why the post-write document has to be CHECKED,
        not just trusted: a web edit landing between the write and the re-read
        is carried back in it, and the listener only ever delivers a given
        document once, so suppressing that echo would lose the edit for good —
        and the next startup would then read local as newer and destroy it in
        the cloud too. When the document holds more than we sent, it is applied
        locally through the same callback a listener delivery uses.

        Returns True when the write landed.
        """
        if not self.connected or not self.db:
            self.logger.warning("Cannot push local config - not connected to Firestore")
            return False

        payload = config_sync.normalize(local_config)
        if not payload:
            self.logger.warning("Cannot push local config - nothing to send")
            return False

        base_before = self.cached_config

        try:
            config_ref = self.db.collection('config').document(self.site_id)\
                .collection('machines').document(self.machine_id)

            # Hash BEFORE the write, or the listener thread can fire in the gap
            # between write and hash and loop on our own change.
            self._last_uploaded_config_hash = hashlib.md5(
                json.dumps(payload, sort_keys=True).encode()
            ).hexdigest()

            config_ref.set(payload, merge=True)

            post_write = self.get_config()  # also refreshes cached_config + the disk cache
            anchor = post_write if post_write is not None else payload
            config_hash = hashlib.md5(
                json.dumps(anchor, sort_keys=True).encode()
            ).hexdigest()
            self._last_uploaded_config_hash = config_hash

            self.logger.info(
                f"Local config change pushed to Firestore ({reason}, hash: {config_hash[:8]}...)"
            )

            if post_write is not None:
                expected = config_sync.deep_merge(
                    config_sync.normalize(base_before), payload)
                if not config_sync.configs_equal(post_write, expected):
                    # Something landed between the write and the re-read — a
                    # dashboard edit. Anchoring the guards on this document would
                    # make the listener's single delivery of it look like our own
                    # echo and the edit would never reach config.json. Roll the
                    # cache back instead: the delivery then passes both guards and
                    # applies through the ordinary path, on the listener's thread.
                    self.logger.warning(
                        "Config push came back carrying changes we did not send "
                        "(concurrent dashboard edit) — leaving them for the config "
                        "listener to apply"
                    )
                    self._last_uploaded_config_hash = None
                    self._restore_cached_config(base_before)

            return True

        except Exception as e:
            # Write failed — clear, or a later legitimate change is suppressed.
            self._last_uploaded_config_hash = None
            self.logger.warning(f"Failed to push local config to Firestore ({reason}): {e}")
            self.connection_manager.report_error(e, "Push local config")
            return False

    def sync_config_on_startup(self) -> str:
        """Reconcile config.json against Firestore at startup.

        Three-way, against the last-known-remote cache: whoever moved since the
        last sync wins, and cloud wins a genuine conflict (loudly). An
        unconditional pull was silently reverting every local edit made while
        the cloud sat still.

        Returns:
            'pulled'  - config was pulled from Firestore and applied locally
            'pushed'  - local config was newer and was uploaded
            'in_sync' - local and Firestore already agree; nothing applied
            'seeded'  - local config was uploaded as seed (new machine)
            'offline' - Firestore unreachable or the push failed; local config
                        left as-is
        """
        if not self.connected or not self.db:
            self.logger.warning("Cannot sync config on startup - not connected to Firestore")
            return 'offline'

        try:
            # Snapshot the cache first: get_config() overwrites it.
            base = self.cached_config

            # raise_on_error, because a None from a FAILED read is indistinguishable
            # from a None for an ABSENT document — and the absent branch seeds,
            # which on a transient 5xx would put installer defaults over an
            # operator's dashboard-configured processes.
            try:
                firestore_config = self.get_config(raise_on_error=True)
            except Exception as e:
                self.logger.warning(
                    f"Config sync on startup: Firestore read failed ({e}) - "
                    f"using local config as-is"
                )
                return 'offline'

            local_config = shared_utils.read_config()

            # A falsy document still falls back to the cache; a stale snapshot
            # cannot decide who is newer either.
            if base is not None and firestore_config is base:
                self.logger.warning(
                    "Config sync on startup: no Firestore document read - using local config as-is"
                )
                return 'offline'

            action, conflict = config_sync.decide_startup_sync(
                base, local_config, firestore_config)

            if action == 'seed':
                if local_config:
                    self.upload_config(config_sync.normalize(local_config))
                    self.logger.info("New machine - seeded Firestore with local config")
                    return 'seeded'
                self.logger.warning("No local config to seed Firestore with")
                return 'offline'

            config_hash = hashlib.md5(
                json.dumps(firestore_config, sort_keys=True).encode()
            ).hexdigest()

            if action == 'in_sync':
                # No callback: applying a config identical to the one on disk
                # only rewrites the file and re-runs every launch-mode diff.
                self._last_uploaded_config_hash = config_hash
                self.logger.info(f"Config in sync with Firestore (hash: {config_hash[:8]}...)")
                return 'in_sync'

            if action == 'push':
                self.logger.info("Config sync on startup: local changes pushed to Firestore")
                if self.push_local_config(local_config, reason='newer local config at startup'):
                    return 'pushed'
                return 'offline'

            if conflict:
                self.logger.warning(
                    f"Config conflict: cloud and local both changed since last sync; "
                    f"cloud wins. Discarding local differences in {conflict}"
                )

            self._last_uploaded_config_hash = config_hash
            self.logger.info(f"Config pulled from Firestore (hash: {config_hash[:8]}...)")

            # Same callback the listener uses
            if self.config_update_callback:
                self.config_update_callback(firestore_config)

            return 'pulled'

        except Exception as e:
            self.logger.error(f"Failed to sync config on startup: {e}")
            return 'offline'

    def _load_cached_config(self):
        """Load cached config from disk."""
        try:
            if os.path.exists(self.config_cache_path):
                with open(self.config_cache_path, 'r') as f:
                    self.cached_config = json.load(f)
                self.logger.debug(f"Loaded cached config from {self.config_cache_path}")
        except Exception as e:
            self.logger.error(f"Failed to load cached config: {e}")

    def _merge_into_cached_config(self, patch: Dict):
        """Fold an agent-originated config write into the last-known-remote cache.

        Keeps the cache equal to what Firestore now holds so the write's own
        echo is recognised by the config listener instead of being applied as a
        foreign change.
        """
        try:
            merged = config_sync.deep_merge(self.cached_config or {}, patch)
            self.cached_config = merged
            self._save_cached_config(merged)
        except Exception as e:
            self.logger.debug(f"Could not mirror a config write into the cache: {e}")

    def _mirror_config_patch_to_disk(self, patch: Dict):
        """Fold an agent-originated config write into config.json too.

        Suppressing a write's own echo means config.json no longer learns about
        it for free. The auto-restore breaker counts by reading
        displays.autoRestore.circuitBreaker.failures back off DISK, so without
        this the counter reads 0 forever, the breaker never trips, and a machine
        re-applies display topology on every drift.

        _invalidate_config_cache is shared_utils' documented "call after any
        in-process write" hook; write_json_to_file holds the cross-process JSON
        mutex.
        """
        try:
            local = shared_utils.read_config()
            if not local:
                return
            merged = config_sync.deep_merge(local, patch)
            if merged == local:
                return
            shared_utils.write_json_to_file(merged, shared_utils.CONFIG_PATH)
            shared_utils._invalidate_config_cache(merged)
        except Exception as e:
            self.logger.debug(f"Could not mirror a config write into config.json: {e}")

    def _restore_cached_config(self, snapshot: Optional[Dict]):
        """Roll the cache back to a pre-write snapshot, on disk as well as in memory.

        Leaving the cache anchored on a document we did not fully author would
        make the listener's single delivery of it look like a self-echo, and a
        restart before that delivery would read the foreign edit as ours and
        overwrite it in the cloud.
        """
        self.cached_config = snapshot
        try:
            if snapshot is None:
                if os.path.exists(self.config_cache_path):
                    os.remove(self.config_cache_path)
            else:
                self._save_cached_config(snapshot)
        except Exception as e:
            self.logger.debug(f"Could not roll the config cache back: {e}")

    def _save_cached_config(self, config: Dict):
        """Save config to disk cache."""
        try:
            os.makedirs(os.path.dirname(self.config_cache_path), exist_ok=True)
            with open(self.config_cache_path, 'w') as f:
                json.dump(config, f, indent=2)
            self.logger.debug("Config cached to disk")
        except Exception as e:
            self.logger.error(f"Failed to save cached config: {e}")

    # Callback Registration

    def register_command_callback(self, callback: Callable):
        """
        Register a callback function to handle commands.

        Args:
            callback: Function that takes (cmd_id, cmd_data) and returns result
        """
        self.command_callback = callback
        self.logger.debug("Command callback registered")

    def register_config_update_callback(self, callback: Callable):
        """
        Register a callback function to handle config updates.

        Args:
            callback: Function that takes (config) and handles the update
        """
        self.config_update_callback = callback
        self.logger.debug("Config update callback registered")

    # Machine Flags (reboot, shutdown, reboot pending)

    def set_machine_flag(self, flag_name, value):
        """Set a flag on the machine's presence document (e.g., rebooting, shuttingDown)."""
        if not self.connected or not self.db:
            return

        try:
            machine_ref = self.db.collection('sites').document(self.site_id)\
                .collection('machines').document(self.machine_id)

            machine_ref.set({flag_name: value}, merge=True)
            self.logger.debug(f"[FLAG] Set {flag_name}={value} on machine document")
        except Exception as e:
            self.logger.error(f"Failed to set machine flag {flag_name}: {e}")

    def set_machine_flags(self, flags: dict):
        """Atomically set multiple flags on the machine document in a SINGLE write.

        Use this instead of multiple set_machine_flag() calls when the dashboard
        must observe several fields together — e.g. rebootScheduledAt + rebooting
        + rebootCancellable for the scheduled-reboot announcement. Multiple
        separate set_machine_flag() calls would produce multiple Firestore writes
        and intermediate listener ticks where the dashboard sees a half-applied
        state (e.g. rebooting=true but rebootScheduledAt still null), causing
        the cancel-button countdown to lag or render incorrectly.

        UNLIKE set_machine_flag(), this method RAISES on failure rather than
        silently logging. Callers that depend on atomic visibility (e.g. the
        scheduled-reboot announce path) must catch and react to the exception.
        """
        if not self.connected or not self.db:
            raise RuntimeError("Firebase client not connected")

        machine_ref = self.db.collection('sites').document(self.site_id)\
            .collection('machines').document(self.machine_id)

        machine_ref.set(flags, merge=True)
        self.logger.debug(
            f"[FLAG] Atomically set {len(flags)} flags on machine document: "
            f"{list(flags.keys())}"
        )

    def set_reboot_pending(self, process_name, reason, timestamp):
        """Write a reboot_pending object to the machine document when relaunch limit is exceeded.

        True when the row reached Firestore. Off Windows the relaunch gate
        the escalation arms is cleared by a dashboard dismiss and nothing
        else, so a caller that armed it on an unwritten row froze every
        relaunch on the machine with nothing on screen to clear it.
        """
        if not self.connected or not self.db:
            return False

        try:
            machine_ref = self.db.collection('sites').document(self.site_id)\
                .collection('machines').document(self.machine_id)

            machine_ref.set({
                'rebootPending': {
                    'active': True,
                    'processName': process_name,
                    'reason': reason,
                    'timestamp': timestamp
                }
            }, merge=True)
            self.logger.info(f"[FLAG] Reboot pending set for process: {process_name}")
            return True
        except Exception as e:
            self.logger.error(f"Failed to set reboot pending: {e}")
            return False

    def clear_reboot_pending(self):
        """Clear the reboot_pending flag on the machine document."""
        if not self.connected or not self.db:
            return

        try:
            machine_ref = self.db.collection('sites').document(self.site_id)\
                .collection('machines').document(self.machine_id)

            machine_ref.set({
                'rebootPending': {
                    'active': False,
                    'processName': None,
                    'reason': None,
                    'timestamp': None
                }
            }, merge=True)
            self.logger.debug("[FLAG] Reboot pending cleared")
        except Exception as e:
            self.logger.error(f"Failed to clear reboot pending: {e}")

    def mirror_reboot_state(self, state):
        """Best-effort mirror of local reboot_state.json to Firestore for dashboard visibility.

        Writes to sites/{siteId}/machines/{machineId}.rebootState. Silent on
        offline — local state file remains source of truth.

        Args:
            state: dict from reboot_state.read_state() — has 'lastFiredByEntry' and 'attempt'.
        """
        if not self.connected or not self.db:
            return

        try:
            machine_ref = self.db.collection('sites').document(self.site_id)\
                .collection('machines').document(self.machine_id)

            # Only the fields the dashboard reads.
            attempt = state.get('attempt')
            mirror_attempt = None
            if attempt:
                mirror_attempt = {
                    'entryId': attempt.get('entryId'),
                    'scheduledFor': attempt.get('scheduledFor'),
                    'lastAttemptAt': attempt.get('lastAttemptAt'),
                    'status': attempt.get('status'),
                }

            machine_ref.set({
                'rebootState': {
                    'lastFiredByEntry': state.get('lastFiredByEntry', {}),
                    'attempt': mirror_attempt,
                }
            }, merge=True)
            self.logger.debug("[REBOOT] Mirrored reboot state to Firestore")
        except Exception as e:
            self.logger.debug(f"Failed to mirror reboot state (non-critical): {e}")

    # Event Logging

    def log_event(self, action: str, level: str, process_name: str = None, details: str = None, user_id: str = None, extra_fields: dict = None, doc_id: str = None, **kwargs):
        """
        Log a process event to Firestore. Failures are swallowed — logging must
        never crash the app.

        Args:
            action: process_start, process_killed, process_crash, ...
            level: info | warning | error
            extra_fields: merged as top-level fields; reserved keys (timestamp,
                action, level, machineId, machineName, processName, details,
                userId, screenshotUrl) are dropped to protect the canonical shape.
            doc_id: explicit doc id, used as a dedup key so a re-submit overwrites
                idempotently (deferred flushes such as watchdog restart events).

        Returns the doc id, or None on failure / when disconnected — callers
        recording submission success must check it.
        """
        if not self.connected or not self.db:
            return None

        try:
            logs_ref = self.db.collection('sites').document(self.site_id)\
                .collection('logs')

            event_data = {
                'timestamp': SERVER_TIMESTAMP,
                'action': action,
                'level': level,
                'machineId': self.machine_id,
                'machineName': shared_utils.get_hostname(),
            }

            if process_name:
                event_data['processName'] = process_name
            if details:
                event_data['details'] = details
            if user_id:
                event_data['userId'] = user_id
            if kwargs.get('screenshot_url'):
                event_data['screenshotUrl'] = kwargs['screenshot_url']

            if extra_fields:
                reserved = {
                    'timestamp', 'action', 'level', 'machineId', 'machineName',
                    'processName', 'details', 'userId', 'screenshotUrl',
                }
                for key, value in extra_fields.items():
                    if key in reserved:
                        continue
                    event_data[key] = value

            import uuid
            if not doc_id:
                doc_id = str(uuid.uuid4())
            doc_ref = logs_ref.document(doc_id)
            doc_ref.set(event_data)

            self.logger.debug(f"[EVENT LOGGED] {action} - {process_name} ({level})")
            return doc_id

        except Exception as e:
            self.logger.debug(f"[EVENT LOG FAILED] {action}: {e}")
            return None

    def send_process_alert(self, process_name, error_message, event_type='process_crash'):
        """Backward-compatible wrapper for process alerts."""
        self.send_alert(event_type, {
            'process_name': process_name,
            'error_message': error_message or 'Process exited unexpectedly',
        })

    def send_display_alert(self, event_type: str, data: dict):
        """Route a display event to ``POST /api/agent/alert`` for email/webhook.

        Callers (``display_manager._emit_audit``, ``owlette_service._emit_display_event``)
        also write the event to ``sites/{siteId}/logs``, which drives the feed and
        the talon bridge — neither write replaces the other.

        Only ``DISPLAY_ALERT_EVENT_TYPES`` are forwarded; anything else would hit
        the endpoint's generic branch and duplicate the log doc in the feed.

        Never raises, and never blocks (send_alert is a daemon thread) — safe from
        the main service loop.
        """
        if event_type not in DISPLAY_ALERT_EVENT_TYPES:
            self.logger.debug(
                f"[ALERT] Display event {event_type} has no alert routing; log-only"
            )
            return
        try:
            self.send_alert(event_type, data)
        except Exception as e:  # dispatch must never break the audit-log caller
            self.logger.debug(f"[ALERT] send_display_alert({event_type}) failed: {e}")

    def send_alert(self, event_type: str, data: dict):
        """Send a generic agent alert to the web API.

        ``data`` is event-specific and passed through as-is. Send failures queue
        into ``_pending_alerts``, drained by the connection-state listener on
        reconnect, so operator-relevant events survive an outage.

        Non-blocking: the POST runs on a daemon thread.
        """
        def _send():
            try:
                token = self.auth_manager.get_valid_token()
                api_base = shared_utils.get_api_base_url()
                import requests
                response = requests.post(
                    f"{api_base}/agent/alert",
                    json={
                        'siteId': self.site_id,
                        'machineId': self.machine_id,
                        'eventType': event_type,
                        'data': data,
                        'agentVersion': shared_utils.APP_VERSION,
                    },
                    headers={'Authorization': f'Bearer {token}'},
                    timeout=10
                )
                response.raise_for_status()
                self.logger.info(f"[ALERT] Alert sent: {event_type}")
            except Exception as e:
                self.logger.warning(
                    f"Failed to send alert ({event_type}); queueing for retry: {e}"
                )
                self._enqueue_pending_alert(event_type, data)

        thread = threading.Thread(target=_send, daemon=True)
        thread.start()

    def _enqueue_pending_alert(self, event_type: str, data: dict):
        """Queue a failed alert in memory; drops the oldest at the cap so a long
        outage can't OOM the agent. Drained on the next CONNECTED transition."""
        with self._pending_alerts_lock:
            if len(self._pending_alerts) >= self._PENDING_ALERTS_MAX:
                dropped = self._pending_alerts.pop(0)
                self.logger.warning(
                    f"[ALERT] Pending alert queue full; dropped oldest "
                    f"({dropped.get('event_type')})"
                )
            self._pending_alerts.append({
                'event_type': event_type,
                'data': data,
            })

    def _drain_pending_alerts_async(self):
        """Retry queued alerts on a daemon thread; called by the connection-state
        listener on transition to CONNECTED."""
        with self._pending_alerts_lock:
            pending = list(self._pending_alerts)
            self._pending_alerts.clear()
        if not pending:
            return

        def _drain():
            self.logger.info(
                f"[ALERT] Draining {len(pending)} pending alerts after reconnect"
            )
            for entry in pending:
                # Via send_alert so a second outage mid-drain re-enqueues cleanly.
                self.send_alert(entry['event_type'], entry['data'])

        threading.Thread(target=_drain, daemon=True).start()

    def get_chunk_download_urls(self, chunk_hashes: list) -> dict:
        """
        Fetch signed R2 download URLs for chunks (POST /api/chunks/download-urls).

        URLs are short-lived (<=15 min), so sync_downloader re-fetches on 403 /
        expired. The route scopes siteId against the token claims.

        Args:
            chunk_hashes: lowercase 64-char SHA-256 hex strings; server caps at
                1000 per request.

        Returns {hash: download_url}. Raises requests.RequestException on network
        failure, ValueError on a malformed response.
        """
        if not chunk_hashes:
            return {}
        token = self.auth_manager.get_valid_token()
        api_base = shared_utils.get_api_base_url()
        import requests

        # Server cap is 1000; 500 leaves headroom for a future reduction, bounds
        # the work lost to one transient failure, and stays under the edge's
        # request-size cap on pathological roosts.
        BATCH = 500
        hashes = list(chunk_hashes)
        merged: dict = {}
        for start in range(0, len(hashes), BATCH):
            batch = hashes[start:start + BATCH]
            resp = requests.post(
                f"{api_base}/chunks/download-urls",
                json={'siteId': self.site_id, 'hashes': batch},
                headers={'Authorization': f'Bearer {token}'},
                timeout=30,
            )
            resp.raise_for_status()
            body = resp.json()
            urls = body.get('urls')
            if not isinstance(urls, dict):
                raise ValueError(
                    f"chunks/download-urls returned malformed body "
                    f"(missing 'urls' dict): {body!r}"
                )
            merged.update(urls)
        return merged

    def get_version_download_url(self, roost_id: str, version_id: str) -> str:
        """
        Mint a fresh signed GET URL for a version JSON body.

        Valid 15 min, so a URL baked into the roost doc at publish time is usually
        expired before a canary wave starts — every sync_pull mints its own, same
        as the per-chunk pattern.

        version_id is the 64-char SHA-256 hex id. Raises requests.RequestException
        on network failure, ValueError on a malformed response.
        """
        token = self.auth_manager.get_valid_token()
        api_base = shared_utils.get_api_base_url()
        import requests
        resp = requests.post(
            f"{api_base}/roosts/{roost_id}/version-url",
            json={
                'siteId': self.site_id,
                'versionId': version_id,
            },
            headers={'Authorization': f'Bearer {token}'},
            timeout=30,
        )
        resp.raise_for_status()
        body = resp.json()
        url = body.get('url')
        if not isinstance(url, str) or not url:
            raise ValueError(
                f"version-url returned malformed body "
                f"(missing 'url' string): {body!r}"
            )
        return url

    def ship_logs(self, log_entries: list):
        """
        Ship log entries to Firestore. Failures are swallowed — logging must never
        crash the app.

        log_entries: dicts with timestamp, level, message, logger, filename, line.
        """
        if not self.connected or not self.db:
            return

        try:
            batch = self.db.batch()

            logs_ref = self.db.collection('sites').document(self.site_id)\
                .collection('machines').document(self.machine_id)\
                .collection('logs')

            for log_entry in log_entries:
                log_entry['server_timestamp'] = SERVER_TIMESTAMP
                log_entry['machine_id'] = self.machine_id
                log_entry['site_id'] = self.site_id

                doc_ref = logs_ref.document()
                batch.set(doc_ref, log_entry)

            batch.commit()
            self.logger.debug(f"Shipped {len(log_entries)} log entries to Firebase")

        except Exception as e:
            self.logger.debug(f"Log shipping failed: {e}")

    # Software Inventory

    def sync_software_inventory(self):
        """Force a software inventory sync — call after a deployment. Never raises."""
        try:
            self._sync_software_inventory(force=True)
            self.logger.debug("Software inventory synced on-demand")
        except Exception as e:
            self.logger.error(f"On-demand software inventory sync failed: {e}")

    def _calculate_software_hash(self, software_list):
        """MD5 over name:version pairs, order-independent — the change detector."""
        sorted_software = sorted(software_list, key=lambda s: (s.get('name', ''), s.get('version', '')))

        software_str = '|'.join([
            f"{s.get('name', '')}:{s.get('version', '')}"
            for s in sorted_software
        ])

        return hashlib.md5(software_str.encode('utf-8')).hexdigest()

    def _sync_software_inventory(self, force=False):
        """
        Upload the platform's installed-software inventory to
        sites/{site_id}/machines/{machine_id}/installed_software.

        force=True syncs even when the hash is unchanged (on-demand refresh).
        """
        import osadapter

        if not self.connected or not self.db:
            return

        try:
            installed_software = osadapter.installed_software()

            if not installed_software:
                self.logger.debug("No installed software detected")
                return

            current_hash = self._calculate_software_hash(installed_software)

            if not force and current_hash == self._last_software_inventory_hash:
                self.logger.debug("Software inventory unchanged, skipping sync")
                return

            software_collection_ref = self.db.collection('sites').document(self.site_id)\
                .collection('machines').document(self.machine_id)\
                .collection('installed_software')

            try:
                existing_docs = software_collection_ref.stream()
                for doc in existing_docs:
                    doc.reference.delete()
            except Exception as e:
                self.logger.warning(f"Failed to clear existing software inventory: {e}")

            batch_write_failed = False

            try:
                batch = self.db.batch()
                batch_count = 0
                committed_count = 0

                for software in installed_software:
                    doc_id = f"{software['name']}_{software['version']}".replace('/', '_').replace('\\', '_')
                    doc_id = doc_id[:1500]

                    doc_ref = software_collection_ref.document(doc_id)

                    software_data = {
                        **software,
                        'detected_at': SERVER_TIMESTAMP
                    }

                    batch.set(doc_ref, software_data)
                    batch_count += 1

                    if batch_count >= 500:
                        try:
                            batch.commit()
                            committed_count += batch_count
                        except Exception as mid_batch_error:
                            self.logger.warning(f"Mid-batch commit failed after {committed_count} docs: {mid_batch_error}")
                            raise
                        batch = self.db.batch()
                        batch_count = 0

                if batch_count > 0:
                    batch.commit()
                    committed_count += batch_count

                self.logger.info(f"Synced {len(installed_software)} software packages to Firestore (batch write)")
                self._last_software_inventory_hash = current_hash

            except Exception as batch_error:
                self.logger.info(f"Batch write not available (using individual writes instead)")
                self.logger.debug(f"Batch write error: {batch_error}")
                batch_write_failed = True

            if batch_write_failed:
                success_count = 0
                for software in installed_software:
                    try:
                        doc_id = f"{software['name']}_{software['version']}".replace('/', '_').replace('\\', '_')
                        doc_id = doc_id[:1500]

                        doc_ref = software_collection_ref.document(doc_id)
                        software_data = {
                            **software,
                            'detected_at': SERVER_TIMESTAMP
                        }
                        doc_ref.set(software_data)
                        success_count += 1
                    except Exception as write_error:
                        self.logger.warning(f"Failed to write {software.get('name', 'unknown')}: {write_error}")

                self.logger.info(f"Synced {success_count}/{len(installed_software)} software packages (individual writes)")
                if success_count == len(installed_software):
                    self._last_software_inventory_hash = current_hash
                else:
                    self.logger.warning(f"Partial software sync: {success_count}/{len(installed_software)} — will retry on next sync")

        except Exception as e:
            self.logger.error(f"Failed to sync software inventory: {e}")
            self.logger.exception("Software inventory sync error details:")
            self.connection_manager.report_error(e, "Software inventory sync")
