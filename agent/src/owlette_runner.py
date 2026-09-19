"""
owlette Service Runner — the process the service host supervises.

Runs the service main loop without the Windows Service framework: the SCM talks
to owlette-host.exe (agent/host), which launches this script, keeps it alive,
and reports the service's state. That state is the shutdown signal — see the SCM
stop watcher below.
"""
import sys
import os
import datetime
import logging
import threading
import time
import signal

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import shared_utils

# read by signal_handler and the console control handler
_service_instance = None

def signal_handler(signum, frame):
    """Handle Ctrl+C and other termination signals.

    Not the service-stop path: owlette-host reports STOP_PENDING and waits, which
    the SCM stop watcher below picks up. (NSSM's Control-C trick was best-effort
    and on 2026-08-13 silently never fired — the machine was killed without
    flushing presence and sat on the dashboard as online.) This covers every other
    console event: manual runs, system shutdown, Ctrl+Break. Real work is in
    OwletteService.graceful_shutdown(), which both callers share — first one wins,
    exactly once.
    """
    global _service_instance

    try:
        sig_name = signal.Signals(signum).name
    except (ValueError, AttributeError):
        # Windows console events (CTRL_SHUTDOWN_EVENT=6, etc.) aren't in signal.Signals
        sig_name = f"CTRL_EVENT_{signum}"
    msg = f"[SIGNAL HANDLER] Received signal {signum} ({sig_name})"
    logging.critical(msg)
    print(msg, file=sys.stderr, flush=True)

    if _service_instance is None:
        logging.critical("[SIGNAL HANDLER] ERROR: _service_instance is None - cannot perform graceful shutdown")
        print("[SIGNAL HANDLER] ERROR: _service_instance is None", file=sys.stderr, flush=True)
        sys.exit(0)

    try:
        performed = _service_instance.graceful_shutdown(f'console_{sig_name.lower()}')
        print(
            f"[SIGNAL HANDLER] shutdown {'performed' if performed else 'already done'}",
            file=sys.stderr, flush=True,
        )
    except Exception as e:
        logging.error(f"[SIGNAL HANDLER] graceful_shutdown failed: {e}")
        print(f"[SIGNAL HANDLER] graceful_shutdown failed: {e}", file=sys.stderr, flush=True)

    # the host is waiting on us
    sys.exit(0)

FIREBASE_AVAILABLE = False
FIREBASE_IMPORT_ERROR = None
try:
    from firebase_client import FirebaseClient
    from auth_manager import AuthManager
    FIREBASE_AVAILABLE = True
except ImportError as e:
    FIREBASE_IMPORT_ERROR = str(e)

if __name__ == '__main__':
    log_level = shared_utils.get_log_level_from_config()
    shared_utils.initialize_logging("service", level=log_level)

    # after logging, before the exception hooks
    import sentry_utils
    sentry_utils.initialize_sentry(shared_utils.read_config(), shared_utils.APP_VERSION)

    from owlette_service import _handle_unhandled_exception, _handle_thread_exception
    sys.excepthook = _handle_unhandled_exception
    threading.excepthook = _handle_thread_exception

    logging.info("Running under owlette-host (not win32serviceutil)")

    from owlette_service import OwletteService

    # Mirrors OwletteService.__init__ — every new self.* attribute there MUST be
    # added here too or the runner dies with AttributeError under the host.
    class MockService:
        def __init__(self):
            self._service_start_time = time.time()

            import os
            if not os.path.exists(shared_utils.RESULT_FILE_PATH):
                from owlette_service import Util
                Util.initialize_results_file()
                logging.info("Initialized new app_states.json file")

            logging.info(f"Config path: {shared_utils.CONFIG_PATH}")
            shared_utils.upgrade_config()

            try:
                from health_probe import HealthProbe
                _api_base = shared_utils.read_config(['firebase', 'api_base']) or shared_utils.get_api_base_url()
                self._health_state = HealthProbe(
                    config_path=shared_utils.CONFIG_PATH,
                    api_base=_api_base,
                ).run()
                logging.info(f"Startup health probe: status={self._health_state.status}, results={self._health_state.probe_results}")
                if not self._health_state.is_ok():
                    logging.error(f"Health probe failed: {self._health_state.error_code} — {self._health_state.error_message}")
            except Exception as e:
                logging.error(f"Health probe error: {e}")
                self._health_state = None

            self._auth_manager = None
            self._api_base = shared_utils.read_config(['firebase', 'api_base']) or shared_utils.get_api_base_url()

            self.is_alive = True
            self._restart_exit_code = 0
            self.tray_icon_pid = None
            # reboot-prompt suppression deadline; read by reached_max_relaunch_attempts
            self._restart_prompt_until = 0.0
            # "desktop app not found" log de-spam; read by launch_desktop_app_as_user
            self._desktop_exe_missing_logged = False
            self.relaunch_attempts = {}
            self.first_start = True
            self.last_started = {}
            self.config = shared_utils.load_config()
            self.processes = []
            self.results = {}
            self.current_time = datetime.datetime.now()
            self.active_installations = {}
            self.install_locks = {}
            self.manual_overrides = {}
            self._skip_launch_delay = set()
            self._last_seen_launch_modes = {}
            self._last_seen_launch_schedules = {}
            # taken by handle_process_launch / kill_and_relaunch_process on every launch
            self._launch_locks = {}
            self._launch_locks_guard = threading.Lock()
            self._cached_site_timezone = None
            self._reboot_schedule_counter = 0
            self._reboot_attempt_started_monotonic = None
            self._display_check_counter = 0
            self._cached_display_hash = None
            self._cached_display_profile = None
            # auto-restore drift-persistence gate
            self._drift_pending_tick_count = 0
            self._drift_pending_key = None
            self._last_auto_restore_success_key = None
            self._scm_stop_requested = False
            self._shutting_down = False
            self._live_view_active = False
            self._live_view_stop_time = 0
            self.cortex_pid = None
            # roost periodic scrub state, read by the main-loop scrub hook
            self._roost_scrub_check_counter = 0
            self._roost_scrub_thread = None
            # Mirrors the service attr; the IPC pump dispatcher reads it on
            # the first tick, so debug mode AttributeErrors without it.
            self._cortex_ipc_thread = None
            # swoop: built by main() once Firebase is up; the tick reads these first
            self.swoop_manager = None
            self.swoop_doorbell = None
            self._swoop_shutdown = threading.Event()
            self._last_console_session_id = None
            self._swoop_session_thread = None
            self._swoop_active_since = 0

            # handle_firebase_command checks has_handler() before falling through
            from command_router import CommandRouter
            self._command_router = CommandRouter()
            try:
                from sync_commands import register_handlers as _register_roost_handlers
                _register_roost_handlers(self._command_router)
            except Exception as e:
                logging.warning(f"Failed to register roost handlers: {e}")
            try:
                from machine_commands import register_handlers as _register_machine_handlers
                _register_machine_handlers(self._command_router)
            except Exception as e:
                logging.warning(f"Failed to register machine-api handlers: {e}")
            try:
                from process_commands import register_handlers as _register_process_handlers
                _register_process_handlers(self._command_router)
            except Exception as e:
                logging.warning(f"Failed to register process-control handlers: {e}")
            try:
                from swoop_commands import register_handlers as _register_swoop_handlers
                _register_swoop_handlers(self._command_router)
            except Exception as e:
                logging.warning(f"Failed to register swoop handlers: {e}")
            # _write_service_status() throttle (OwletteService's hasattr guard is a backstop)
            self._last_status_signature = None
            self._last_status_write_time = 0.0
            # case-4 recovery throttle: Firebase enabled but no running client
            self._firebase_reinit_not_before = 0.0
            # Once-only guard: the console handler and the SCM stop watcher both fire
            # on one stop and would otherwise double-write offline / agent_stopped.
            self._shutdown_lock = threading.Lock()
            self._shutdown_trigger = None
            # ConnectionManager the status-file listener is bound to; re-wired on Firebase re-init
            self._connection_status_manager = None
            # local-config push detection, read by _check_local_config_changes every tick
            self._local_config_mtime = None
            self._applying_remote_config = False
            self._config_push_thread = None
            # guards the two writers of _local_config_mtime (push thread + apply)
            self._config_baseline_lock = threading.Lock()
            # push retry pacing, read by _check_local_config_changes every tick
            import config_sync as _config_sync
            self._push_backoff = _config_sync.PushBackoff()
            self._push_attempt_mtime = None
            # one-WARNING-per-episode flag for a blind SCM stop watcher
            self._scm_query_failure_logged = False

            self.firebase_client = None
            logging.info(f"Firebase check - Available: {FIREBASE_AVAILABLE}")

            if not FIREBASE_AVAILABLE and FIREBASE_IMPORT_ERROR:
                logging.warning(f"Firebase client not available - Import error: {FIREBASE_IMPORT_ERROR}")
                logging.warning("Running in local-only mode")

            if FIREBASE_AVAILABLE:
                firebase_enabled = shared_utils.read_config(['firebase', 'enabled'])
                logging.info(f"Firebase config - enabled: {firebase_enabled}")

                if firebase_enabled:
                    try:
                        site_id = shared_utils.read_config(['firebase', 'site_id'])
                        project_id = shared_utils.read_config(['firebase', 'project_id'])
                        api_base = shared_utils.read_config(['firebase', 'api_base'])
                        cache_path = shared_utils.get_data_path('cache/firebase_cache.json')

                        logging.info(f"Firebase config - site_id: {site_id}, project_id: {project_id}")
                        logging.info(f"Firebase API base: {api_base}")

                        # Cold boot reaches service start before the NIC has a route;
                        # building AuthManager there burns the first token refresh and
                        # arms a backoff for nothing. Bounded 90s, non-fatal.
                        try:
                            from health_probe import wait_for_network, reprobe_if_network_error
                            if wait_for_network(api_base or self._api_base):
                                # the probe's network_error verdict predates the NIC; refresh it
                                self._health_state = reprobe_if_network_error(
                                    self._health_state,
                                    shared_utils.CONFIG_PATH,
                                    api_base or self._api_base,
                                )
                        except Exception as e:
                            logging.warning(f"Network gate error (proceeding anyway): {e}")

                        auth_manager = AuthManager(api_base=api_base)

                        if not auth_manager.is_authenticated():
                            logging.error("Agent not authenticated - no refresh token found in encrypted storage")
                            logging.error("Please run the installer to complete OAuth authentication")
                            self.firebase_client = None
                        else:
                            logging.info("Agent authenticated - OAuth tokens found")
                            self.firebase_client = FirebaseClient(
                                auth_manager=auth_manager,
                                project_id=project_id,
                                site_id=site_id,
                                config_cache_path=cache_path
                            )
                            logging.info(f"Firebase client initialized for site: {site_id}")
                    except Exception as e:
                        logging.error(f"Failed to initialize Firebase client: {e}")
                        logging.exception("Firebase initialization error details:")
                        self.firebase_client = None

            logging.info("Service initialization complete")

    try:
        # before the signal handlers, which need _service_instance
        mock_service = MockService()

        # bind OwletteService.main() to the mock instance
        _service_instance = object.__new__(OwletteService)
        _service_instance.__dict__.update(mock_service.__dict__)

        # so the tray can show alerts before Firebase connects
        try:
            _service_instance._write_service_status_early()
        except Exception as e:
            logging.error(f"Failed to write early service status: {e}")

        # The client reached CONNECTED inside MockService with nobody listening;
        # publish it now or the tray badge stays red until main() gets here.
        try:
            _service_instance._wire_connection_status_listener()
        except Exception as e:
            logging.error(f"Failed to wire the connection status listener: {e}")

        signal.signal(signal.SIGINT, signal_handler)   # Ctrl+C
        signal.signal(signal.SIGTERM, signal_handler)  # Termination request
        signal.signal(signal.SIGBREAK, signal_handler) # Ctrl+Break (Windows)
        logging.info("Signal handlers registered for graceful shutdown")

        # a Windows console stop is a control event, not a POSIX signal
        if sys.platform == 'win32':
            try:
                import win32api
                def windows_handler(ctrl_type):
                    """Handle Windows console control events"""
                    ctrl_names = {
                        0: 'CTRL_C_EVENT',
                        1: 'CTRL_BREAK_EVENT',
                        2: 'CTRL_CLOSE_EVENT',
                        5: 'CTRL_LOGOFF_EVENT',
                        6: 'CTRL_SHUTDOWN_EVENT'
                    }
                    ctrl_name = ctrl_names.get(ctrl_type, f'UNKNOWN({ctrl_type})')
                    logging.critical(f"[WINDOWS HANDLER] Received {ctrl_name}")
                    print(f"[WINDOWS HANDLER] Received {ctrl_name}", file=sys.stderr, flush=True)

                    signal_handler(ctrl_type, None)
                    return True  # Indicate we handled it

                win32api.SetConsoleCtrlHandler(windows_handler, True)
                logging.info("Windows console control handler registered")
            except ImportError:
                logging.warning("win32api not available - Windows control handler not registered")
            except Exception as e:
                logging.error(f"Failed to register Windows control handler: {e}")

        # The stop that cannot be missed: owlette-host reports STOP_PENDING on
        # accept and waits 20s for us to exit, so this watcher always gets there first.
        try:
            _service_instance.start_scm_stop_watcher()
        except Exception as e:
            logging.error(f"Failed to start the SCM stop watcher: {e}")

        logging.info("Starting main service loop...")
        _service_instance.main()

        # 42/43 = the host relaunches immediately (agent/host/src/supervisor.rs)
        exit_code = getattr(_service_instance, '_restart_exit_code', 0)

        logging.info("Main loop exited - performing cleanup...")
        if _service_instance.firebase_client:
            # fallback: main()'s finally and the signal handler normally stop it first
            if hasattr(_service_instance.firebase_client, 'running') and _service_instance.firebase_client.running:
                try:
                    # a 42/43 restart comes straight back; skip the offline flush so presence doesn't flap
                    _service_instance.firebase_client.stop(intentional=bool(exit_code))
                    logging.info("Firebase client stopped")
                except Exception as e:
                    logging.error(f"Error stopping Firebase client: {e}")
            else:
                logging.info("Firebase client already stopped (by signal handler)")

        if exit_code:
            logging.info(f"Service exiting with code {exit_code} for an immediate host restart")
        else:
            logging.info("Service stopped cleanly (exit 0 — the host stops the service)")
        sys.exit(exit_code)

    except KeyboardInterrupt:
        logging.info("Service stopped by user (Ctrl+C)")
        sys.exit(0)
    except Exception as e:
        logging.error(f"Service crashed: {e}", exc_info=True)
        sys.exit(1)
