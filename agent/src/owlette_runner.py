"""
owlette Service Runner — the process the service host supervises.

Runs the service main loop without the Windows Service framework: the SCM talks
to owlette-host.exe (agent/host), which launches this script, keeps it alive,
and reports the service's state. That state is the shutdown signal — see the SCM
stop watcher below.

`--debug` runs the same loop in the foreground with console logging — the
replacement for the retired `owlette_service.py debug` entry point.
"""
import sys
import os
import argparse
import logging
import threading
import signal

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import shared_utils

# read by signal_handler and the console control handler
_service_instance = None


def _parse_args(argv):
    """Runner CLI. No arguments is the hosted path; --debug is a manual run."""
    parser = argparse.ArgumentParser(
        prog='owlette_runner',
        description='run the owlette service loop in this process',
    )
    parser.add_argument(
        '--debug',
        action='store_true',
        help='log at DEBUG level to this console as well as the service log',
    )
    return parser.parse_args(argv)


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
    args = _parse_args(sys.argv[1:])

    log_level = logging.DEBUG if args.debug else shared_utils.get_log_level_from_config()
    shared_utils.initialize_logging("service", level=log_level)
    if args.debug:
        console_handler = logging.StreamHandler(sys.stderr)
        console_handler.setFormatter(
            logging.Formatter('%(asctime)s - %(levelname)s - %(message)s'))
        logging.getLogger().addHandler(console_handler)

    # after logging, before the exception hooks
    import sentry_utils
    sentry_utils.initialize_sentry(shared_utils.read_config(), shared_utils.APP_VERSION)

    from owlette_service import _handle_unhandled_exception, _handle_thread_exception
    sys.excepthook = _handle_unhandled_exception
    threading.excepthook = _handle_thread_exception

    logging.info("Running under owlette-host")

    from owlette_service import OwletteService, Util

    try:
        if not os.path.exists(shared_utils.RESULT_FILE_PATH):
            Util.initialize_results_file()
            logging.info("Initialized new app_states.json file")

        logging.info(f"Config path: {shared_utils.CONFIG_PATH}")
        shared_utils.upgrade_config()

        # OwletteService has no constructor of its own: this file owns the
        # startup sequence. Everything main() and its helpers read comes from
        # the one shared _init_state(), so a new service attribute cannot go
        # missing here.
        _service_instance = object.__new__(OwletteService)
        _service_instance._init_state()

        try:
            from health_probe import HealthProbe
            _service_instance._health_state = HealthProbe(
                config_path=shared_utils.CONFIG_PATH,
                api_base=_service_instance._api_base,
            ).run()
            logging.info(
                f"Startup health probe: status={_service_instance._health_state.status}, "
                f"results={_service_instance._health_state.probe_results}"
            )
            if not _service_instance._health_state.is_ok():
                logging.error(
                    f"Health probe failed: {_service_instance._health_state.error_code} — "
                    f"{_service_instance._health_state.error_message}"
                )
        except Exception as e:
            logging.error(f"Health probe error: {e}")
            _service_instance._health_state = None

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
                        if wait_for_network(api_base or _service_instance._api_base):
                            # the probe's network_error verdict predates the NIC; refresh it
                            _service_instance._health_state = reprobe_if_network_error(
                                _service_instance._health_state,
                                shared_utils.CONFIG_PATH,
                                api_base or _service_instance._api_base,
                            )
                    except Exception as e:
                        logging.warning(f"Network gate error (proceeding anyway): {e}")

                    auth_manager = AuthManager(api_base=api_base)

                    if not auth_manager.is_authenticated():
                        logging.error("Agent not authenticated - no refresh token found in encrypted storage")
                        logging.error("Please run the installer to complete OAuth authentication")
                        _service_instance.firebase_client = None
                    else:
                        logging.info("Agent authenticated - OAuth tokens found")
                        _service_instance.firebase_client = FirebaseClient(
                            auth_manager=auth_manager,
                            project_id=project_id,
                            site_id=site_id,
                            config_cache_path=cache_path
                        )
                        logging.info(f"Firebase client initialized for site: {site_id}")
                except Exception as e:
                    logging.error(f"Failed to initialize Firebase client: {e}")
                    logging.exception("Firebase initialization error details:")
                    _service_instance.firebase_client = None

        logging.info("Service initialization complete")

        # so the tray can show alerts before Firebase connects
        try:
            _service_instance._write_service_status_early()
        except Exception as e:
            logging.error(f"Failed to write early service status: {e}")

        # The client reached CONNECTED during the startup above with nobody
        # listening; publish it now or the tray badge stays red until main().
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
        # Not under --debug: nothing is hosting us there, the SCM reports the
        # service as STOPPED, and the watcher would read that as a stop and
        # shut this process down on its first tick. The signal and console
        # handlers above already cover a foreground stop.
        if not args.debug:
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
