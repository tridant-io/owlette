"""
owlette site configuration — device code pairing flow.

Runs during install: requests a 3-word pairing phrase, shows it, polls until an
operator authorizes it on owlette.app/add or the dashboard, then stores the OAuth
tokens (`.tokens.enc` in the agent's data root) and writes site_id / project_id /
api_base into config.json.

Usage:
    python configure_site.py [--url URL] [--server {dev,prod}] [--add PHRASE] [--no-browser]

    --url URL        Override the API base URL. Requires --server.
    --server NAME    Which owlette server to pair with (dev or prod). Required
                     whenever --url is given; otherwise the machine keeps the
                     environment its config is already bound to.
    --add PHRASE     Pre-authorized pairing phrase (polls immediately)
    --no-browser     Retained for compatibility; no browser is opened on this
                     machine any more. The link is printed and polling starts
                     either way. Also OWLETTE_NO_BROWSER=1.

Headless modes (the desktop app's bridge into the agent — see
`_run_headless_mode`). Each writes one JSON object per line to stdout and nothing
else, and never touches the console/clipboard UI above:

    --json-progress      Pair this machine, emitting phrase/status/authorized/error.
                         With --no-service-restart the agent is left running,
                         which is what the daemon's own pairing child uses.
    --leave              Leave the current site (config, cache, service, machine doc).
    --report-issue FILE  Submit the feedback payload in FILE to `bug_reports`.
    --reboot-now         Record an owlette-initiated reboot and restart the machine.
    --dismiss-reboot     Clear the cloud rebootPending flag for this machine.
    --preseed            Pair from the preseed a POSIX package left in the tree.
"""

import datetime
import json
import logging
import os
import secrets
import shutil
import stat
import subprocess
import sys
import time
import argparse
from pathlib import Path
from typing import Optional, Callable

import osadapter
import shared_utils

CONFIG_PATH = Path(shared_utils.get_data_path('config/config.json'))

# Default timeout for polling (10 minutes, matching server-side expiry)
TIMEOUT_SECONDS = 600

# The POSIX analogue of the Windows installer's `/ADD=<phrase> /SILENT`: the
# package writes the operator's phrase here and `postinst` / `postinstall` runs
# `configure_site.py --preseed`. Retired by renaming rather than deleting, so a
# support case can still see what an image was built with.
PRESEED_PATH = 'config/pairing.json'
PRESEED_CONSUMED_PATH = 'config/pairing.json.used'
# The explicit re-pair opt-in: set in the environment, it pairs even a machine
# that already carries a site, which the preseed file alone never does.
PRESEED_ENV_VAR = 'OWLETTE_ADD'

# An owlette-initiated restart of the machine. One second is the shortest delay
# Windows still lets the operator abort. The POSIX arms schedule in whole
# minutes and round anything shorter up to one, so the same click reboots a
# second later on Windows and a minute later there; the message is what a POSIX
# shutdown broadcasts to the sessions it is about to end.
_REBOOT_DELAY_SECONDS = 1
_REBOOT_MESSAGE = 'owlette is restarting this machine'

# ANSI color codes (Windows 10+ supports these natively)
CYAN = '\033[96m'
GREEN = '\033[92m'
RED = '\033[91m'
DIM = '\033[2m'
BOLD = '\033[1m'
RESET = '\033[0m'


def _enable_ansi_colors():
    """Enable ANSI escape code processing on Windows."""
    if sys.platform == 'win32':
        try:
            import ctypes
            kernel32 = ctypes.windll.kernel32
            # Enable ENABLE_VIRTUAL_TERMINAL_PROCESSING
            kernel32.SetConsoleMode(kernel32.GetStdHandle(-11), 7)
        except Exception:
            pass


def _copy_to_clipboard(text: str) -> bool:
    """
    Best-effort copy of ``text`` to the Windows clipboard via win32clipboard
    (ships with pywin32 — no extra dependency). Returns True on success.

    Never raises: the clipboard can be transiently locked by another process,
    and a failed copy must never block pairing - the phrase is still shown on
    screen. Windows-only; a no-op elsewhere.
    """
    if sys.platform != 'win32':
        return False
    try:
        import win32clipboard
        win32clipboard.OpenClipboard()
        try:
            win32clipboard.EmptyClipboard()
            win32clipboard.SetClipboardText(text, win32clipboard.CF_UNICODETEXT)
        finally:
            win32clipboard.CloseClipboard()
        return True
    except Exception as e:
        logging.debug(f"Clipboard copy failed (non-fatal): {e}")
        return False


def _determine_environment(environment: str = None) -> tuple:
    """(environment, api_base, project_id) for an explicit token, else the config's.

    The two tables this used to inline now live in shared_utils; this is the only
    place that assembles them into the 3-tuple the pairing flow needs.
    """
    if environment not in ('development', 'production'):
        environment = shared_utils.get_environment()
    return (environment,
            shared_utils.get_api_base_url(environment),
            shared_utils.get_project_id(environment))


def _save_config(site_id: str, environment: str, api_base: str, project_id: str):
    """Save site configuration to config.json (tokens stored separately in .tokens.enc)."""
    CONFIG_PATH.parent.mkdir(parents=True, exist_ok=True)

    if CONFIG_PATH.exists():
        try:
            with open(CONFIG_PATH, 'r') as f:
                config = json.load(f)
        except (json.JSONDecodeError, OSError) as e:
            logging.warning(f"Config file corrupted or unreadable ({e}), starting fresh")
            config = None
    else:
        config = None

    if config is None:
        config = {
            "_comment": "owlette Configuration - Edit this file to add processes to monitor",
            "version": shared_utils.CONFIG_VERSION,
            "processes": [],
            "logging": {
                "level": "INFO",
                "max_age_days": 90,
                "firebase_shipping": {
                    "enabled": False,
                    "ship_errors_only": True
                }
            },
            "firebase": {
                "_comment": "Cloud features: remote control, web dashboard, metrics",
                "enabled": False,
                "site_id": ""
            }
        }

    if 'firebase' not in config:
        config['firebase'] = {}

    config['firebase']['enabled'] = True
    config['firebase']['site_id'] = site_id
    config['firebase']['project_id'] = project_id
    config['firebase']['api_base'] = api_base
    config['environment'] = environment

    if 'token' in config.get('firebase', {}):
        del config['firebase']['token']

    # Atomic write: write to temp file, then replace
    tmp_path = CONFIG_PATH.with_suffix('.tmp')
    with open(tmp_path, 'w') as f:
        # `ShouldConfigureSite` in agent/owlette_installer.iss string-searches
        # this file for '"environment": "development"' and '"enabled": true' —
        # key, colon, ONE space, value — which depends on json.dump's default
        # ': ' item separator, so never pass a custom `separators=` here. The
        # indent is *not* part of that contract: it controls only leading
        # whitespace, and the service rewrites this same config.json with
        # indent=4 (`shared_utils.write_json_to_file`) while those searches
        # still match.
        json.dump(config, f, indent=2)
    # POSIX: config.json is 0660 root:<group> so the desktop app can write it
    # too, and a replacement written at the daemon's umask would lock that
    # writer out until the next service start — a pairing through the request
    # seam restarts nothing.
    shared_utils._carry_file_identity(CONFIG_PATH, tmp_path)
    os.replace(tmp_path, CONFIG_PATH)


def run_pairing_flow(api_base: str = None, environment: str = None,
                     add_phrase: str = None,
                     timeout_seconds: int = TIMEOUT_SECONDS,
                     show_prompts: bool = True,
                     on_phrase: Optional[Callable[[dict], None]] = None,
                     should_cancel: Optional[Callable[[], bool]] = None,
                     copy_clipboard: bool = True):
    """
    Run device code pairing flow to configure site authentication.

    This function can be called from:
    - Command line (configure_site.py main())
    - run_json_progress(), the desktop app's spawned subprocess
    - Installer (Inno Setup), which also goes through main()

    Args:
        api_base: API base URL (defaults to the resolved environment's)
        environment: 'development' or 'production'. Anything else (including
            None) falls back to the environment this machine's config is bound
            to. The caller normalises the operator's --server token exactly once,
            in main().
        add_phrase: Pre-authorized pairing phrase (for /ADD= silent install)
        timeout_seconds: Max time to wait for authorization
        show_prompts: Show console output (False for GUI usage)
        on_phrase: Optional callback invoked once in interactive mode with the
            device_data dict (pairPhrase, pairingUrl, verificationUri,
            expiresIn, ...) plus a 'clipboardCopied' bool, so a GUI caller can
            render its own phrase UI. Exceptions raised by it are swallowed.
        should_cancel: Optional predicate polled while waiting for
            authorization; when it returns True the wait is abandoned and the
            flow returns (False, "Cancelled by user", None). The only
            production value is run_json_progress's status heartbeat, which
            never returns True; the desktop app cancels by killing this process.
        copy_clipboard: Copy the phrase to the Windows clipboard. True for the
            console/installer flow, where the operator has no other way to get
            it into owlette.app/add. The desktop app owns its own clipboard
            affordance and passes False so a background subprocess never steals
            the operator's clipboard.

    Returns:
        tuple: (success: bool, message: str, site_id: Optional[str])
    """
    from auth_manager import AuthManager, AuthenticationError

    environment, default_api_base, project_id = _determine_environment(environment)
    api_base = api_base or default_api_base

    # Named again in the authorize block below, so resolved outside the
    # `show_prompts` guard rather than twice inside it.
    env_label = shared_utils.get_environment_label(environment)
    env_host = shared_utils.get_web_host(environment)
    env_color = CYAN if environment == 'development' else GREEN

    if show_prompts:
        _enable_ansi_colors()
        print(f"{DIM}{'=' * 60}{RESET}")
        print(f"{BOLD}owlette site configuration{RESET}")
        print(f"{DIM}{'=' * 60}{RESET}")
        print(f"  environment: {BOLD}{env_color}{env_label}{RESET}")
        print(f"  {DIM}api: {api_base}{RESET}")
        print()

    if show_prompts and not add_phrase and CONFIG_PATH.exists():
        try:
            with open(CONFIG_PATH, 'r') as f:
                config = json.load(f)
                if config.get('firebase', {}).get('enabled') and config.get('firebase', {}).get('site_id'):
                    print(f"  already configured with site: {CYAN}{config['firebase']['site_id']}{RESET}")
                    print()
                    response = input("  reconfigure? (y/N): ").strip().lower()
                    if response != 'y':
                        return (False, "User cancelled reconfiguration", None)
        except Exception:
            pass

    auth_manager = AuthManager(api_base=api_base)

    try:
        if add_phrase:
            # Silent mode: phrase was pre-authorized on dashboard
            if show_prompts:
                print(f"Using pre-authorized phrase: {add_phrase}")
                print("Polling for authorization...")
                print()

            # /ADD= polls with the pairPhrase directly: the admin's phrase IS the
            # device_codes document id, so the agent needs no device code of its own.
            import requests as http_requests

            poll_url = f"{api_base}/agent/auth/device-code/poll"
            start_time = time.time()
            interval = 5

            while time.time() - start_time < timeout_seconds:
                try:
                    response = http_requests.post(
                        poll_url,
                        json={
                            'pairPhrase': add_phrase,
                            'machineId': auth_manager.machine_id,
                            'version': shared_utils.APP_VERSION,
                        },
                        timeout=15,
                    )

                    if response.status_code == 202:
                        if show_prompts:
                            elapsed = int(time.time() - start_time)
                            print(f"\r  Waiting for authorization... ({elapsed}s)", end='', flush=True)
                        time.sleep(interval)
                        continue

                    if response.status_code == 200:
                        data = response.json()
                        access_token = data.get('accessToken')
                        refresh_token = data.get('refreshToken')
                        expires_in = data.get('expiresIn', 3600)
                        site_id = data.get('siteId')

                        if not access_token or not refresh_token or not site_id:
                            return (False, "Invalid response from server (missing tokens)", None)

                        expiry_timestamp = time.time() + expires_in
                        auth_manager.storage.save_refresh_token(refresh_token)
                        auth_manager.storage.save_access_token(access_token, expiry_timestamp)
                        auth_manager.storage.save_site_id(site_id)

                        _save_config(site_id, environment, api_base, project_id)

                        if show_prompts:
                            print()
                            print()
                            print(f"{DIM}{'=' * 60}{RESET}")
                            print(f"  {GREEN}{BOLD}configuration complete!{RESET}")
                            print(f"{DIM}{'=' * 60}{RESET}")
                            print(f"  site: {CYAN}{site_id}{RESET}")
                            print(f"  {DIM}config: {CONFIG_PATH}{RESET}")
                            print()

                        return (True, "Configuration successful", site_id)

                    if response.status_code == 410:
                        return (False, "Pairing phrase expired. Generate a new one from the dashboard.", None)

                    if response.status_code == 404:
                        return (False, f"Pairing phrase not found: {add_phrase}", None)

                    error_msg = response.json().get('error', f"HTTP {response.status_code}")
                    return (False, f"Poll failed: {error_msg}", None)

                except http_requests.exceptions.RequestException as e:
                    if show_prompts:
                        print(f"\n  Network error (retrying): {e}")
                    time.sleep(interval)
                    continue

            return (False, "Timed out waiting for authorization", None)

        else:
            # Interactive mode: request device code and open pairing page
            if show_prompts:
                print(f"  {DIM}requesting pairing code from server...{RESET}")
                print()

            device_data = auth_manager.request_device_code()

            pair_phrase = device_data['pairPhrase']
            device_code = device_data['deviceCode']
            verification_uri = device_data['verificationUri']
            interval = device_data.get('interval', 5)
            expires_in = device_data.get('expiresIn', 600)

            # Copy the phrase so the operator can paste it into owlette.app/add.
            # Best-effort — a locked/unavailable clipboard never blocks pairing.
            phrase_copied = _copy_to_clipboard(pair_phrase) if copy_clipboard else False

            if show_prompts:
                print(f"{DIM}{'=' * 60}{RESET}")
                print()
                print(f"  pairing phrase:  {BOLD}{CYAN}{pair_phrase}{RESET}")
                if phrase_copied:
                    print(f"  {DIM}{GREEN}(copied to clipboard){RESET}")
                print()
                print(f"  {DIM}authorize this machine on{RESET} {env_color}{env_label}{RESET}{DIM}:{RESET}")
                print(f"  {CYAN}{verification_uri}{RESET}")
                print(f"  {DIM}this phrase exists only on {env_host} — it will not be found anywhere else.{RESET}")
                print()
                print(f"  {DIM}expires in {expires_in // 60} minutes{RESET}")
                print()
                print(f"{DIM}{'=' * 60}{RESET}")
                print()

            # Let an embedding caller (the GUI) render its own phrase UI. A failing
            # callback must never break pairing.
            if on_phrase:
                try:
                    on_phrase({**device_data, 'clipboardCopied': phrase_copied})
                except Exception as cb_err:
                    logging.warning(f"on_phrase callback failed: {cb_err}")

            if show_prompts:
                print(f"  {BOLD}waiting for authorization...{RESET}")

            # Authorization from ANY device ends the wait; should_cancel is the
            # heartbeat hook — no production caller returns True from it.
            success = auth_manager.poll_device_code(
                device_code=device_code,
                interval=interval,
                timeout=expires_in,
                should_cancel=should_cancel,
            )

            if success:
                site_id = auth_manager._site_id

                _save_config(site_id, environment, api_base, project_id)

                if show_prompts:
                    print()
                    print(f"{DIM}{'=' * 60}{RESET}")
                    print(f"  {GREEN}{BOLD}configuration complete!{RESET}")
                    print(f"{DIM}{'=' * 60}{RESET}")
                    print(f"  site: {CYAN}{site_id}{RESET}")
                    print(f"  {DIM}environment: {environment}{RESET}")
                    print(f"  {DIM}config: {CONFIG_PATH}{RESET}")
                    print()

                return (True, "Configuration successful", site_id)
            else:
                # False only on cancellation; failure/expiry raises AuthenticationError.
                if should_cancel and should_cancel():
                    return (False, "Cancelled by user", None)
                return (False, "Authorization failed", None)

    except AuthenticationError as e:
        error_msg = str(e)
        if show_prompts:
            print()
            print(f"{DIM}{'=' * 60}{RESET}")
            print(f"  {RED}{BOLD}configuration failed{RESET}")
            print(f"{DIM}{'=' * 60}{RESET}")
            print(f"  {RED}{error_msg}{RESET}")
            print()
        return (False, error_msg, None)

    except KeyboardInterrupt:
        if show_prompts:
            print()
            print(f"  {DIM}cancelled by user{RESET}")
        return (False, "Cancelled by user", None)

    except Exception as e:
        error_msg = f"Unexpected error: {e}"
        if show_prompts:
            print(f"Error: {error_msg}")

        import traceback
        try:
            debug_log = Path(shared_utils.get_data_path('logs/pairing_debug.log'))
            debug_log.parent.mkdir(parents=True, exist_ok=True)
            with open(debug_log, 'a') as f:
                f.write(f"\nPairing Flow Error\n")
                f.write(f"==================\n")
                f.write(f"Error: {e}\n")
                f.write(f"Traceback:\n{traceback.format_exc()}\n")
        except Exception:
            pass

        return (False, error_msg, None)


# Headless modes — the desktop app's bridge into the agent.
#
# The desktop app owns no cloud client and no token crypto; both stay here behind
# the bundled interpreter. It spawns `configure_site.py <mode>` and reads stdout,
# so every mode speaks one protocol: one JSON object per line,
# `{"event": ..., "value": ...}`, flushed as it happens.
#
#   phrase      pairing phrase and its URLs, once              (--json-progress)
#   status      human-readable progress, safe to show verbatim      (all modes)
#   authorized  pairing completed; value carries `siteId`     (--json-progress)
#   done        a non-pairing mode completed; value carries its outcome
#   error       the mode failed; value is the message to show
#
# Exactly one terminal event (authorized/done/error) per run, and the exit code
# agrees: 0 success, 1 failure. Only `_emit` writes to stdout.

# Cadence of the --json-progress "waiting" status; the desktop app renders a live
# elapsed time from it.
_STATUS_HEARTBEAT_SECONDS = 15

# Settle margin around service stop/start — now only for Firestore to catch up
# with the leave write (the adapter's controls are synchronous, unlike nssm).
_SERVICE_STOP_SETTLE = 3
_SERVICE_START_SETTLE = 2

# Feedback categories the web API accepts (`web/app/api/bug-report/route.ts`).
_REPORT_CATEGORIES = ('bug', 'feature_request', 'other', 'compliment', 'rant')

# Legacy dialog labels (`report_issue.ReportIssueApp.CATEGORY_MAP`), still
# accepted so a payload written by either UI resolves the same way.
_REPORT_CATEGORY_ALIASES = {
    'feature request': 'feature_request',
    'feedback': 'other',
}


def _event_line(event: str, value=None) -> str:
    """One line of the progress protocol, ASCII-escaped and newline-terminated.

    Spelled once so the daemon's answers into the `ipc/` seam and the console's
    own stdout are the same stream, parsed by the same reader.
    """
    return json.dumps({'event': event, 'value': value}) + '\n'


def _emit(event: str, value=None) -> None:
    """Write one progress line to stdout and flush it.

    Deliberately not exception-guarded: the only realistic failure is the parent
    closing the pipe, and in that case this process must die rather than keep
    polling for ten minutes with nobody listening.
    """
    sys.stdout.write(_event_line(event, value))
    sys.stdout.flush()


def _service_control(verb: str) -> bool:
    """start / stop / restart the agent service; True once it reached the state.

    The adapter carries per platform what `owlette-host <verb>` did here, with
    the two properties the callers rely on unchanged:

    * `stop` is synchronous — it waits for the service to reach stopped, which
      is the window the agent uses to flush `online: false` and log
      agent_stopped. `nssm stop` returned while its child was still alive.
    * A service that is already in the requested state is a success, because
      what the caller wants is the state, not the transition.

    Never raises: leaving a site must complete even where the service cannot be
    controlled from this session — a standard user is not granted SERVICE_STOP,
    and off Windows the unit belongs to the init system — exactly as the GUI
    teardown behaved. The return value lets the caller tell the operator which
    half happened.
    """
    try:
        return osadapter.service_control(verb, shared_utils.SERVICE_NAME)
    except Exception as e:
        logging.warning(f"Service {verb} failed: {e}")
        return False


def _machine_document(project_id: str, api_base: str, site_id: str):
    """Resolve `sites/{site_id}/machines/{machine_id}` through the agent's client.

    Returns (client, document_ref). The caller closes the client. Raises
    RuntimeError when this machine has no usable credentials — the desktop app
    never sees the token store, so the message is what it shows the operator.
    """
    from auth_manager import AuthManager
    from firestore_rest_client import FirestoreRestClient

    if not project_id:
        raise RuntimeError('no firebase project is configured for this machine')
    if not site_id:
        raise RuntimeError('this machine is not paired with a site')

    auth_manager = AuthManager(api_base=api_base)
    if not auth_manager.is_authenticated():
        raise RuntimeError('owlette is not authenticated with the cloud')

    client = FirestoreRestClient(project_id=project_id, auth_manager=auth_manager)
    document = client.collection('sites').document(site_id) \
        .collection('machines').document(shared_utils.get_machine_id())
    return client, document


def run_json_progress(api_base: str = None, environment: str = None,
                      timeout_seconds: int = TIMEOUT_SECONDS,
                      restart_service: bool = True) -> int:
    """Pair this machine, reporting progress as JSON lines.

    The same `run_pairing_flow` the installer runs, with the console and
    clipboard affordances switched off: the desktop app renders the phrase
    itself and owns the clipboard. Cancellation is the caller killing this
    process — the device code simply expires server-side.

    `restart_service` is False for the run the daemon spawns into the `ipc/`
    seam: that child is inside the unit it would otherwise stop, and stopping
    it would take the child down with it wherever the init system kills by
    control group.
    """
    _emit('status', 'requesting a pairing phrase')

    last_heartbeat = [time.monotonic()]

    def heartbeat() -> bool:
        # Polled every ~0.25 s by `AuthManager.poll_device_code`; keeps the status
        # line alive. Never cancels.
        now = time.monotonic()
        if now - last_heartbeat[0] >= _STATUS_HEARTBEAT_SECONDS:
            last_heartbeat[0] = now
            _emit('status', 'waiting for authorization')
        return False

    def on_phrase(device_data: dict) -> None:
        _emit('phrase', {
            'pairPhrase': device_data.get('pairPhrase', ''),
            'pairingUrl': (device_data.get('pairingUrl')
                           or device_data.get('qrUrl')
                           or device_data.get('verificationUri', '')),
            'verificationUri': device_data.get('verificationUri', ''),
            'expiresIn': device_data.get('expiresIn', 600),
        })
        _emit('status', 'waiting for authorization')

    success, message, site_id = run_pairing_flow(
        api_base=api_base,
        environment=environment,
        timeout_seconds=timeout_seconds,
        show_prompts=False,
        copy_clipboard=False,
        on_phrase=on_phrase,
        should_cancel=heartbeat,
    )

    if not success:
        _emit('error', message)
        return 1

    # Restarting is a latency optimisation, not a correctness requirement: the
    # service re-reads the firebase config every 2 loop iterations
    # (`owlette_service.SLEEP_INTERVAL` = 5) and reinitialises its client on the
    # disabled -> enabled transition, so a machine that is never restarted still
    # appears on the dashboard within ~10 s. The restart turns that wait into an
    # immediate reconnect. Stopping OwletteService needs SERVICE_STOP, which a
    # standard user lacks — so the outcome is reported to the caller rather than
    # only logged, and failing it is not an error.
    restarted = False
    if restart_service:
        _emit('status', 'restarting the service')
        stopped = _service_control('stop')
        time.sleep(_SERVICE_STOP_SETTLE)
        started = _service_control('start')
        time.sleep(_SERVICE_START_SETTLE)
        restarted = stopped and started

    _emit('authorized', {'siteId': site_id, 'serviceRestarted': restarted})
    return 0


def run_leave_site() -> int:
    """Remove this machine from its site.

    Ported from `owlette_gui.on_leave_site_click` (:1968-2092), in the same
    order and for the same reasons: the config is disabled *first* so the
    service cannot recreate the machine document, the cached cloud config goes
    with it, and the service is stopped before the document is deleted.

    One deliberate fix: the GUI read `site_id` back out of the config it had
    just blanked, so its delete addressed `sites//machines/{host}` and never
    removed anything. The site is captured up front here.
    """
    config = shared_utils.load_config()
    firebase_cfg = config.get('firebase') or {}
    site_id = firebase_cfg.get('site_id', '')
    project_id = firebase_cfg.get('project_id', '')
    api_base = firebase_cfg.get('api_base') or shared_utils.get_api_base_url()

    if not site_id:
        _emit('error', 'this machine is not paired with a site')
        return 1

    _emit('status', 'disabling cloud sync')
    if 'firebase' not in config:
        config['firebase'] = {}
    config['firebase']['enabled'] = False
    config['firebase']['site_id'] = ''
    shared_utils.save_config(config)
    logging.info("Firebase disabled and site_id cleared in config")

    # The service prefers the cached cloud config; leaving it would hand the next
    # start a stale site.
    try:
        cache_path = shared_utils.get_data_path('cache/firebase_cache.json')
        if os.path.exists(cache_path):
            os.remove(cache_path)
            logging.info("Deleted cached Firebase config")
    except Exception as e:
        logging.warning(f"Failed to delete cached config (non-critical): {e}")

    _emit('status', 'stopping the service')
    service_stopped = _service_control('stop')
    if service_stopped:
        time.sleep(_SERVICE_STOP_SETTLE)

    _emit('status', 'deregistering this machine')
    deregistered = False
    client = None
    try:
        client, document = _machine_document(project_id, api_base, site_id)
        document.delete()
        deregistered = True
        logging.info("Machine document deleted from Firestore")
    except Exception as e:
        # Non-fatal as in the GUI: already detached locally, and an admin can
        # remove the dashboard row.
        logging.warning(f"Failed to delete machine from Firestore (non-critical): {e}")
    finally:
        if client is not None:
            try:
                client.close()
            except Exception:
                pass

    _emit('status', 'restarting the service')
    _service_control('start')
    time.sleep(_SERVICE_START_SETTLE)

    _emit('done', {
        'siteId': site_id,
        'deregistered': deregistered,
        'serviceStopped': service_stopped,
    })
    return 0


def _normalize_report_category(raw) -> str:
    """Map a payload's category onto one the web API accepts."""
    value = str(raw or '').strip().lower()
    value = _REPORT_CATEGORY_ALIASES.get(value, value)
    return value if value in _REPORT_CATEGORIES else 'other'


def _format_system_info(info: dict) -> str:
    """Format a system-info dict into readable lines."""
    return '\n'.join(f"  {key.replace('_', ' ')}: {value}" for key, value in info.items())


def build_report_data(category: str, description: str) -> dict:
    """Gather system info and recent logs for a feedback submission.

    Ported from `report_issue.build_report_data`; GPU probing is skipped because
    the load and temperature probes are the slow part of a report the operator
    is waiting on.
    """
    config = shared_utils.read_config()
    firebase_cfg = config.get('firebase', {})

    system_info = {}
    try:
        system_info = shared_utils.get_system_metrics(skip_gpu=True)
    except Exception as e:
        logging.warning(f"Failed to gather system info: {e}")

    import platform
    import socket

    return {
        'category': category,
        'title': 'agent feedback',
        'description': description,
        'hostname': socket.gethostname(),
        'siteId': firebase_cfg.get('site_id', ''),
        'os': platform.platform(),
        'systemInfo': system_info,
        'logTail': shared_utils.get_log_tail('service', 100),
    }


def submit_report(data: dict) -> None:
    """POST a feedback report to `/api/bug-report`.

    Ported from `report_issue.submit_report`. The agent's own access token is
    the credential; the endpoint accepts it as a bearer token and files the
    report under `bug_reports` with `source: 'agent'`.
    """
    import requests as http_requests
    from auth_manager import AuthManager

    config = shared_utils.read_config()
    api_base = config.get('firebase', {}).get('api_base') or shared_utils.get_api_base_url()

    auth_manager = AuthManager(api_base=api_base)
    if not auth_manager.is_authenticated():
        raise RuntimeError('owlette is not connected to a site — pair this machine first.')

    token = auth_manager.get_valid_token()
    if not token:
        raise RuntimeError('failed to obtain a valid auth token.')

    web_base = api_base.rstrip('/')
    if web_base.endswith('/api'):
        web_base = web_base[:-len('/api')]

    description = data.get('description', '')
    system_info = data.get('systemInfo', {})
    log_tail = data.get('logTail', '')
    if system_info:
        description += f"\n\n--- system info ---\n{_format_system_info(system_info)}"
    if log_tail:
        description += f"\n\n--- recent logs (last ~100 lines) ---\n{log_tail}"

    # The API rejects anything over 50 000 characters; trim the log tail rather
    # than lose the report.
    if len(description) > 50000:
        description = description[:49950] + '\n\n[truncated]'

    response = http_requests.post(
        f"{web_base}/api/bug-report",
        json={
            'title': data.get('title', 'agent feedback'),
            'category': data.get('category', 'other'),
            'description': description,
            'browserUA': f"Owlette Agent v{shared_utils.APP_VERSION} / {data.get('os', '')}",
            'pageUrl': f"agent://{data.get('hostname', 'unknown')}",
        },
        headers={'Authorization': f'Bearer {token}'},
        timeout=15,
    )

    if response.status_code != 200:
        try:
            error_msg = response.json().get('error', response.text)
        except Exception:
            error_msg = response.text
        raise RuntimeError(f"the server rejected the report ({response.status_code}): {error_msg}")

    try:
        report_id = response.json().get('id', 'unknown')
    except Exception:
        report_id = 'unknown'
    logging.info(f"Bug report submitted via API: {report_id}")


def run_report_issue(payload_path: str) -> int:
    """Submit the feedback payload written by the desktop app.

    The payload is `{"category": ..., "description": ...}` in a file under the
    owlette tree; it is deleted as soon as it has been read so an operator's
    description is not left lying on disk.
    """
    try:
        with open(payload_path, 'r', encoding='utf-8') as f:
            payload = json.load(f)
    except (OSError, ValueError) as e:
        _emit('error', f"could not read the feedback payload: {e}")
        return 1
    finally:
        try:
            os.remove(payload_path)
        except OSError:
            pass

    description = str(payload.get('description') or '').strip()
    if not description:
        _emit('error', 'please describe the issue before submitting.')
        return 1

    category = _normalize_report_category(payload.get('category'))

    _emit('status', 'collecting system info and recent logs')
    try:
        report = build_report_data(category, description)
    except Exception as e:
        _emit('error', f"could not collect diagnostics: {e}")
        return 1

    _emit('status', 'submitting')
    try:
        submit_report(report)
    except Exception as e:
        _emit('error', str(e) or repr(e))
        return 1

    _emit('done', {'category': category})
    return 0


def _record_reboot_intent() -> None:
    """Mark the reboot about to be issued as owlette's own.

    Written *before* the call that fires it, so the next startup classifier
    treats the reboot as planned and stays silent even if the call hangs. A
    missing intent only costs a spurious "unexpected reboot" warning; it must
    never stop the reboot the operator asked for.
    """
    try:
        import session_state
        session_state.set_intent('owlette_reboot')
    except Exception as e:
        logging.warning(f"session_state.set_intent failed before reboot: {e}")


def run_reboot_now() -> int:
    """Restart this machine, recorded as an owlette-initiated reboot.

    Ported from `prompt_restart.PromptRestart.restart_now`.
    """
    _record_reboot_intent()

    _emit('status', 'restarting this machine')
    try:
        osadapter.reboot(_REBOOT_DELAY_SECONDS, _REBOOT_MESSAGE)
    except Exception as e:
        _emit('error', f"could not restart this machine: {e}")
        return 1

    _emit('done', {'rebooting': True})
    return 0


def run_dismiss_reboot() -> int:
    """Clear this machine's cloud `rebootPending` flag.

    The local half of the dashboard's `dismiss_reboot_pending` command: it
    writes the same document shape `FirebaseClient.clear_reboot_pending` writes,
    so a countdown dismissed on the machine stops showing as pending on the
    dashboard. The service's own in-memory prompt gate is not touched — it
    expires on its own (`owlette_service.RESTART_PROMPT_ACTIVE_SECONDS`).
    """
    config = shared_utils.read_config()
    firebase_cfg = config.get('firebase', {})
    site_id = firebase_cfg.get('site_id', '')
    project_id = firebase_cfg.get('project_id', '')
    api_base = firebase_cfg.get('api_base') or shared_utils.get_api_base_url()

    if not site_id:
        # Nothing to clear on an unpaired machine; never fail the dismissal over it.
        _emit('done', {'cleared': False, 'reason': 'not paired'})
        return 0

    client = None
    try:
        client, document = _machine_document(project_id, api_base, site_id)
        document.set({
            'rebootPending': {
                'active': False,
                'processName': None,
                'reason': None,
                'timestamp': None,
            }
        }, merge=True)
    except Exception as e:
        _emit('error', f"could not clear the pending reboot: {e}")
        return 1
    finally:
        if client is not None:
            try:
                client.close()
            except Exception:
                pass

    _emit('done', {'cleared': True})
    return 0


def run_preseed() -> int:
    """Pair this machine from the preseed a POSIX package left in the tree.

    `postinst` / `postinstall` writes `config/pairing.json` — `phrase`,
    `kiosk_user`, `server` — or sets OWLETTE_ADD, then runs this. Device codes
    are single-use server-side and a golden image clones the machine id and the
    refresh token with everything else, so one preseed pairs one machine.

    The decision order is `owlette_installer.iss`'s ShouldConfigureSite: an
    explicit phrase always re-pairs, a machine already bound to a site never
    does, and the preseed is retired the moment a pairing succeeds so a
    re-install cannot spend a phrase the server has already consumed.

    Exit 0 unless a pairing was attempted and failed, which is the only outcome
    a maintainer script may want to treat as an install failure.
    """
    preseed_path = Path(shared_utils.get_data_path(PRESEED_PATH))
    preseed = _read_preseed(preseed_path)
    kiosk_user = _resolve_kiosk_user(preseed)

    explicit = os.environ.get(PRESEED_ENV_VAR, '').strip()
    phrase = explicit or str(preseed.get('phrase') or '').strip()

    if not phrase:
        _emit('done', {'paired': False, 'reason': 'no pairing preseed',
                       'kioskUser': kiosk_user})
        return 0

    if not explicit and _is_paired():
        _emit('done', {'paired': False, 'reason': 'already paired',
                       'kioskUser': kiosk_user})
        return 0

    _emit('status', 'pairing this machine')
    success, message, site_id = run_pairing_flow(
        environment=_preseed_environment(preseed),
        add_phrase=phrase,
        show_prompts=False,
    )

    if not success:
        # The preseed stays where it is: a phrase that expired mid-install is
        # the operator's to retry, and consuming it would leave them nothing.
        _emit('error', message)
        return 1

    _consume_preseed(preseed_path)
    _emit('done', {'paired': True, 'siteId': site_id, 'kioskUser': kiosk_user})
    return 0


def _read_preseed(path: Path) -> dict:
    """The preseed the package wrote, or an empty one when there is none.

    A corrupt file is not a reason to fail an install: pairing is skipped and
    the operator pairs the machine from the dashboard instead.
    """
    try:
        with open(path, 'r', encoding='utf-8') as f:
            preseed = json.load(f)
    except FileNotFoundError:
        return {}
    except (OSError, ValueError) as e:
        logging.warning(f"Pairing preseed at {path} is unreadable: {e}")
        return {}
    if not isinstance(preseed, dict):
        logging.warning(f"Pairing preseed at {path} is not an object")
        return {}
    return preseed


def _consume_preseed(path: Path) -> None:
    """Retire a spent preseed so the next install cannot re-use its phrase."""
    try:
        os.replace(path, shared_utils.get_data_path(PRESEED_CONSUMED_PATH))
    except OSError as e:
        logging.warning(f"Could not retire the pairing preseed: {e}")


def _preseed_environment(preseed: dict) -> Optional[str]:
    """The environment a preseed's `server` token names; None keeps the machine
    on the one its config is already bound to.

    A token that is neither is named in the log rather than quietly dropped: a
    never-paired machine falls through to production, so a dev phrase written
    `"server": "development"` would be spent against owlette.app and time out
    ten minutes later with nothing saying why.
    """
    token = str(preseed.get('server') or '').strip().lower()
    environment = {'dev': 'development', 'prod': 'production'}.get(token)
    if token and environment is None:
        logging.warning(
            f"Pairing preseed names server {token!r}, which is neither 'dev' nor "
            f"'prod' — pairing against {shared_utils.get_environment()}, the "
            f"environment this machine's config carries")
    return environment


def _is_paired() -> bool:
    """Whether this machine already carries a site.

    The same question `owlette_installer.iss`'s ShouldConfigureSite asks of the
    same file, read as JSON rather than string-searched: cloud sync on and a
    non-empty site. A config written by the service but never paired has the
    key and an empty value, which is not a paired machine.
    """
    try:
        with open(CONFIG_PATH, 'r', encoding='utf-8') as f:
            firebase_cfg = json.load(f)['firebase']
        return bool(firebase_cfg['enabled']) and bool(firebase_cfg['site_id'])
    except (OSError, ValueError, TypeError, KeyError, AttributeError):
        # Missing, unreadable, unparseable, or not the shape a paired machine's
        # config has — every one of which means pairing must run, exactly as
        # the installer's own check treats them.
        return False


def _resolve_kiosk_user(preseed: dict) -> Optional[str]:
    """The account the desktop app runs as: the preseed's, else whoever is at
    the machine's graphical session.

    Never guessed. An install with no seat — a kiosk imaged before anyone has
    logged in — is told which account to add to the group by hand instead,
    because group membership is how the app reaches the daemon at all.
    """
    named = str(preseed.get('kiosk_user') or '').strip()
    if named:
        return named
    try:
        user = osadapter.console_user()
    except Exception as e:
        logging.warning(f"Could not resolve the console user: {e}")
        user = None
    if user:
        return user
    command = _group_add_command()
    if command:
        _emit('status',
              f'no graphical session — add the kiosk account by hand: {command}')
    return None


def _group_add_command() -> Optional[str]:
    """How this OS adds an account to the group that reaches the data root;
    None on Windows, where the tree is ACL'd rather than grouped."""
    if sys.platform == 'win32':
        return None
    from osadapter import posix

    return posix.GROUP_ADD


# The privileged-request seam.
#
# Off Windows the desktop app runs as the console user: it reaches the data root
# through the daemon's group, but it can neither write `.tokens.enc` nor control
# the daemon. The actions that need root are therefore requests it drops into
# `ipc/requests/` for the daemon to execute — and that directory is
# group-writable, which makes the seam a privilege boundary rather than a queue.
# A request runs only when all three hold:
#
#   * the file is owned by the uid `console_user()` resolves — nobody else's
#     request is the app's;
#   * it carries no group or world write bit, so what the daemon read is what
#     the app wrote;
#   * it quotes the nonce the daemon last issued, which is one-shot — a request
#     file kept from an earlier session cannot be replayed.
#
# The app stages a request as `<id>.json.tmp` and renames it into place, the
# same rule the hoot queue beside it carries: the daemon reads a `.json` the
# moment it appears, and one caught half-written is refused and unlinked with
# the app still waiting on an answer.
#
# Anything else is unlinked and logged. `leave` is deliberately not a verb:
# deregistration stays an uninstall-time root operation (`prerm` /
# `uninstall.sh`) and a dashboard command, never something the kiosk session can
# ask for.
#
# The daemon answers beside the request, in `<id>.result` and the same JSON-line
# protocol the headless modes write to stdout. The answer is the app's to remove
# — it wrote the request, and the directory is its to write — but only once a
# terminal event has landed in it (`authorized` or `error`): a `pair` is answered
# by the pairing run itself, which keeps writing into that same file for the ten
# minutes it polls, and an answer removed after the phrase line takes the
# authorization with it.
REQUESTS_DIR = 'ipc/requests'
REQUEST_NONCE_PATH = 'ipc/request_nonce'
REQUEST_AUDIT_PATH = 'logs/privileged_requests.log'
# Root-owned and group-readable, all three: the app reads the nonce it has to
# quote and the answer it is waiting on, and can write neither.
REQUEST_NONCE_MODE = 0o640
REQUEST_REPLY_MODE = 0o640
REQUEST_AUDIT_MODE = 0o640
REQUEST_SUFFIX = '.json'
REQUEST_REPLY_SUFFIX = '.result'
# A request is one verb and one nonce. The directory is group-writable, so the
# size of what turns up in it is not the daemon's to trust: without a bound the
# drain reads whatever was planted there straight into memory.
REQUEST_MAX_BYTES = 4096
# One restart or reboot per five minutes. Both end the session the app is asking
# from, and an app that has wedged must not be able to hold a kiosk in a loop.
REQUEST_RATE_LIMIT_SECONDS = 300

REQUEST_VERBS = ('pair', 'restart', 'reboot')
_RATE_LIMITED_VERBS = frozenset({'restart', 'reboot'})

# The pairing this seam started, while it is still polling. A pairing runs for
# ten minutes and writes the token store when it lands, so a second one started
# beside it would race the first over `.tokens.enc` and over the site this
# machine ends up bound to — and the app can ask for one on every tick.
_pairing_child = None


def poll_request_seam() -> bool:
    """Publish the nonce a request has to quote; say whether one is waiting.

    The service loop's tick on the seam — one directory listing and one small
    read. The nonce is published from here rather than when a request arrives
    because the app has to quote one the daemon has already issued: issuing it
    as soon as there is a seam to issue it into is what makes a first request
    possible without a round of refusals. Windows has no seam at all — the app
    there controls the service through the SCM and elevates on a deliberate
    click.
    """
    if sys.platform == 'win32':
        return False
    try:
        with os.scandir(shared_utils.get_data_path(REQUESTS_DIR)) as entries:
            waiting = any(entry.name.endswith(REQUEST_SUFFIX) for entry in entries)
    except OSError:
        return False
    _request_nonce()
    return waiting


def drain_privileged_requests() -> list:
    """Execute what the desktop app asked the daemon to do; the audit rows written.

    Never called on the service loop: a `pair` starts a ten-minute poll and a
    `restart` ends this process. Requests are taken oldest first and every one
    that is honoured rotates the nonce, so a batch written against a single
    nonce yields exactly one execution and the rest are refused.
    """
    if sys.platform == 'win32':
        return []

    directory = shared_utils.get_data_path(REQUESTS_DIR)
    try:
        names = sorted(
            name for name in os.listdir(directory) if name.endswith(REQUEST_SUFFIX)
        )
    except OSError as e:
        logging.debug(f"No request seam at {directory}: {e}")
        return []

    owner_uid = _request_owner_uid()
    nonce = _request_nonce()
    rows = []
    for name in names:
        path = os.path.join(directory, name)
        reply_path = os.path.join(
            directory, name[:-len(REQUEST_SUFFIX)] + REQUEST_REPLY_SUFFIX)
        verb = _accept_request(path, reply_path, owner_uid, nonce)
        if verb is None:
            continue
        nonce = _issue_request_nonce()
        rows.append(_execute_request(verb, reply_path))
    return rows


def _accept_request(path: str, reply_path: str, owner_uid, nonce: str) -> Optional[str]:
    """The verb one request asks for, or None when it is not the app's to ask.

    Every refusal unlinks the request: one the daemon will not execute must not
    be left for the next drain to reconsider. A request that fails the ownership
    or mode check is answered with nothing but a log line — it was not written
    by the session this seam serves, so there is nobody to answer.

    The directory is group-writable, so the entry is opened directly and the
    checks run on that descriptor: never a link the daemon follows out of the
    seam, never a fifo it blocks on, and never a body read before it knows who
    wrote it.
    """
    try:
        fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    except OSError as e:
        return _refuse(path, None, f'could not be opened: {e}')
    try:
        info = os.fstat(fd)
        if not stat.S_ISREG(info.st_mode):
            return _refuse(path, None, 'is not a regular file')
        if owner_uid is None:
            return _refuse(path, None, 'arrived with nobody at a graphical session')
        if info.st_uid != owner_uid:
            return _refuse(
                path, None, f'is owned by uid {info.st_uid}, not the console user')
        if stat.S_IMODE(info.st_mode) & 0o022:
            return _refuse(
                path, None,
                f'is mode {stat.S_IMODE(info.st_mode):04o} — group- or world-writable')
        try:
            payload = _read_request(fd)
        except (OSError, ValueError) as e:
            return _refuse(path, reply_path, f'could not be read: {e}')
    finally:
        os.close(fd)
    if not isinstance(payload, dict):
        return _refuse(path, reply_path, 'is not a request object')
    verb = payload.get('verb')
    if verb not in REQUEST_VERBS:
        return _refuse(
            path, reply_path, f'asks for {verb!r}, which the daemon does not execute')
    if not nonce or payload.get('nonce') != nonce:
        return _refuse(
            path, reply_path, 'does not quote the nonce the daemon last issued')
    _discard(path)
    return verb


def _read_request(fd: int) -> object:
    """One request's payload, off the descriptor its writer was checked on.

    Read last and bounded: the ownership and mode checks say whether this is the
    app's request at all, and nothing a stranger left in the group-writable
    directory is worth a byte of the daemon's memory before they have run.
    """
    raw = b''
    while len(raw) <= REQUEST_MAX_BYTES:
        chunk = os.read(fd, REQUEST_MAX_BYTES + 1 - len(raw))
        if not chunk:
            return json.loads(raw.decode('utf-8'))
        raw += chunk
    raise ValueError(f'is longer than the {REQUEST_MAX_BYTES} bytes a request is')


def _refuse(path: str, reply_path: Optional[str], why: str) -> None:
    """Unlink a request the daemon will not execute, and say why.

    At warning: a refusal is either the app racing a nonce that has already been
    spent or somebody else writing into the group-writable directory, and both
    are worth a line in the service log.
    """
    logging.warning(f"Refused privileged request {os.path.basename(path)}: it {why}")
    _discard(path)
    if reply_path is not None:
        _write_reply(reply_path, ('error', f'owlette did not run this request: it {why}'))
    return None


def _request_owner_uid() -> Optional[int]:
    """The uid a request has to be owned by: whoever is at the machine.

    None when nobody is, which refuses every request — one written while no
    session exists is not the app's.
    """
    import pwd

    try:
        user = osadapter.console_user()
    except Exception as e:
        logging.warning(f"Could not resolve the console user: {e}")
        return None
    if not user:
        return None
    try:
        return pwd.getpwnam(user).pw_uid
    except KeyError:
        logging.warning(f"The console user {user!r} has no account of its own")
        return None


def _request_nonce() -> str:
    """The nonce a request has to quote; a fresh one when there is none yet.

    Read off a descriptor on the entry itself, and only when that entry is the
    file the daemon issued: `ipc/` is group-writable, so one planted under the
    name would otherwise stand in for a nonce the daemon never wrote, and a
    symlink left there would wedge the seam for good. Anything else is removed
    and replaced, which is what makes the seam heal itself.
    """
    path = shared_utils.get_data_path(REQUEST_NONCE_PATH)
    try:
        fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    except FileNotFoundError:
        return _issue_request_nonce()
    except OSError as e:
        return _replace_request_nonce(path, e)
    try:
        with os.fdopen(fd, 'r', encoding='utf-8') as f:
            info = os.fstat(f.fileno())
            if not stat.S_ISREG(info.st_mode):
                raise ValueError('not a regular file')
            if info.st_uid != os.geteuid():
                raise ValueError(f'owned by uid {info.st_uid}, not by the daemon')
            if stat.S_IMODE(info.st_mode) & 0o022:
                raise ValueError(f'mode {stat.S_IMODE(info.st_mode):04o} — '
                                 f'group- or world-writable')
            nonce = f.read().strip()
    except (OSError, ValueError) as e:
        return _replace_request_nonce(path, e)
    return nonce or _issue_request_nonce()


def _replace_request_nonce(path: str, why) -> str:
    """Discard a nonce the daemon did not issue and publish one it did."""
    logging.warning(f"Replacing the request nonce: {why}")
    _discard(path)
    return _issue_request_nonce()


def _issue_request_nonce() -> str:
    """Retire the current nonce and publish its successor.

    Root-owned 0640 in the group-readable tree: the app reads the nonce it must
    quote and can never write one, so a request carrying it was written after
    the daemon last issued it. Answers '' when the tree cannot be written, which
    refuses every request rather than accepting any.

    Created rather than truncated: writing through an entry already in the
    group-writable directory would leave the nonce owned by whoever put it
    there, to rewrite at will.
    """
    path = shared_utils.get_data_path(REQUEST_NONCE_PATH)
    nonce = secrets.token_hex(16)
    try:
        os.makedirs(os.path.dirname(path), exist_ok=True)
        _discard(path)
        fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL,
                     REQUEST_NONCE_MODE)
        try:
            os.fchmod(fd, REQUEST_NONCE_MODE)
            os.write(fd, nonce.encode())
        finally:
            os.close(fd)
    except OSError as e:
        logging.warning(f"Could not issue a request nonce: {e}")
        return ''
    shared_utils.grant_data_group(path)
    return nonce


def _execute_request(verb: str, reply_path: str) -> dict:
    """Run one accepted verb, audit it, and answer the app.

    The audit row goes in before the verb runs, not after: `restart` ends this
    process and `reboot` ends the machine's session, so a row written afterwards
    is a row that never exists — and the rate-limit window is read back out of
    the audit for that same reason.
    """
    if verb == 'pair' and _pairing_in_flight():
        _write_reply(reply_path,
                     ('error', 'owlette is already pairing this machine'))
        return _audit(verb, 'in_progress', 'a pairing started earlier is still polling')

    if verb in _RATE_LIMITED_VERBS:
        waited = _seconds_since_last(verb)
        if waited is not None and waited < REQUEST_RATE_LIMIT_SECONDS:
            _write_reply(reply_path,
                         ('error', f'owlette ran a {verb} less than five minutes ago'))
            return _audit(verb, 'rate_limited',
                          f'{int(REQUEST_RATE_LIMIT_SECONDS - waited)}s left in the window')

    row = _audit(verb, 'executed', '')
    try:
        if verb == 'pair':
            _start_pairing(reply_path)
        elif verb == 'restart':
            _write_reply(reply_path, ('status', 'restarting the service'))
            if not _service_control('restart'):
                # A restart that worked has already ended this process, so
                # reaching the next line at all means it did not.
                _write_reply(reply_path, ('error', 'owlette could not restart the service'))
                return _audit(verb, 'failed', 'the service did not restart')
        else:
            _write_reply(reply_path, ('status', 'restarting this machine'))
            _record_reboot_intent()
            osadapter.reboot(_REBOOT_DELAY_SECONDS, _REBOOT_MESSAGE)
    except Exception as e:
        logging.warning(f"Privileged request {verb} failed: {e}")
        _write_reply(reply_path, ('error', f'owlette could not {verb}: {e}'))
        return _audit(verb, 'failed', str(e))
    return row


def _pairing_in_flight() -> bool:
    """Whether the pairing this seam started is still running."""
    return _pairing_child is not None and _pairing_child.poll() is None


def _start_pairing(reply_path: str) -> None:
    """Pair this machine in the background, the app reading the phrase out of
    the answer as it is written.

    The same `--json-progress` run the desktop app spawns for itself on Windows,
    except that off Windows only the daemon can write the token store — so it
    runs here as root with its progress lines going into the seam instead of
    down a pipe. Ten minutes of polling is not the daemon's to wait on, so
    nothing does — the handle is kept only so a second request cannot start a
    second pairing beside this one.

    `--no-service-restart`: this child runs inside the unit that run would
    otherwise stop, and the daemon picks the new site up on its own within two
    loop iterations anyway.
    """
    global _pairing_child

    argv = [shared_utils.get_python_exe_path(),
            shared_utils.get_path('configure_site.py'), '--json-progress',
            '--no-service-restart']
    fd = _open_reply(reply_path)
    try:
        _pairing_child = subprocess.Popen(
            argv, stdout=fd, stderr=subprocess.DEVNULL,
            stdin=subprocess.DEVNULL, start_new_session=True)
    finally:
        os.close(fd)
    logging.info(f"Pairing this machine as pid {_pairing_child.pid}")
    shared_utils.grant_data_group(reply_path)


def _open_reply(path: str) -> int:
    """A descriptor on one request's answer, owned by the daemon and 0640.

    Appended to and never truncated: the answer is a line protocol, and a `pair`
    hands this same descriptor to the subprocess that writes the rest of it.
    The directory is the app's to write, so an entry already under the name that
    the daemon did not create is removed rather than written through —
    O_NOFOLLOW turns away a symlink, the owner a file planted there, and the
    link count a hard link aimed at something else in the tree.
    """
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_APPEND | os.O_NOFOLLOW,
                 REQUEST_REPLY_MODE)
    info = os.fstat(fd)
    if info.st_uid != os.geteuid() or info.st_nlink != 1:
        os.close(fd)
        _discard(path)
        fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, REQUEST_REPLY_MODE)
    os.fchmod(fd, REQUEST_REPLY_MODE)
    return fd


def _write_reply(path: str, *events) -> None:
    """Answer one request in the line protocol the headless modes speak."""
    try:
        fd = _open_reply(path)
        try:
            os.write(fd, ''.join(
                _event_line(event, value) for event, value in events).encode())
        finally:
            os.close(fd)
    except OSError as e:
        logging.warning(f"Could not answer {os.path.basename(path)}: {e}")
        return
    shared_utils.grant_data_group(path)


def _audit(verb: str, outcome: str, detail: str) -> dict:
    """Append one row to the privileged-request audit and return it.

    An append-only record of what the kiosk session asked the daemon to do and
    what came of it — and the only memory the rate limit has, since a `restart`
    kills the process that would otherwise be holding one.
    """
    row = {
        'at': time.time(),
        'time': datetime.datetime.now().astimezone().isoformat(timespec='seconds'),
        'verb': verb,
        'outcome': outcome,
        'detail': detail,
    }
    logging.info(f"Privileged request {verb}: {outcome}")
    path = shared_utils.get_data_path(REQUEST_AUDIT_PATH)
    try:
        os.makedirs(os.path.dirname(path), exist_ok=True)
        fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_APPEND | os.O_NOFOLLOW,
                     REQUEST_AUDIT_MODE)
        try:
            os.write(fd, (json.dumps(row) + '\n').encode())
        finally:
            os.close(fd)
    except OSError as e:
        logging.warning(f"Could not write the privileged-request audit: {e}")
    return row


def _seconds_since_last(verb: str) -> Optional[float]:
    """How long ago the daemon last executed `verb`; None if it never has.

    Only executed rows count. A refused one must not push the window forward, or
    a single rate-limited request would extend the block by another five
    minutes for as long as the app kept asking.
    """
    try:
        with open(shared_utils.get_data_path(REQUEST_AUDIT_PATH), 'r',
                  encoding='utf-8') as f:
            lines = f.readlines()
    except OSError:
        return None
    for line in reversed(lines):
        try:
            row = json.loads(line)
            if row.get('verb') != verb or row.get('outcome') != 'executed':
                continue
            return max(0.0, time.time() - float(row['at']))
        except (ValueError, TypeError, KeyError, AttributeError):
            continue
    return None


def _discard(path: str) -> None:
    """Remove an entry the seam owns, whether or not it is still there.

    A directory goes whole rather than being skipped: anything in the group can
    create one where a request belongs, and an entry the daemon cannot remove is
    one the poll gate reports as waiting on every tick from then on.
    """
    try:
        if os.path.isdir(path) and not os.path.islink(path):
            shutil.rmtree(path)
        else:
            os.unlink(path)
    except FileNotFoundError:
        pass
    except OSError as e:
        logging.warning(f"Could not remove {path}: {e}")


def _run_headless_mode(args) -> Optional[int]:
    """Dispatch a headless mode, or None when this is an interactive run.

    Returning None is what keeps the installer path untouched: `main` only
    consults this before any of its own work, and every branch below is
    additive.
    """
    selected = [
        name for name, chosen in (
            ('--json-progress', args.json_progress),
            ('--leave', args.leave),
            ('--report-issue', args.report_issue is not None),
            ('--reboot-now', args.reboot_now),
            ('--dismiss-reboot', args.dismiss_reboot),
            ('--preseed', args.preseed),
        ) if chosen
    ]
    if not selected:
        return None
    if len(selected) > 1:
        _emit('error', f"pick one mode, not {' and '.join(selected)}")
        return 2

    try:
        if args.json_progress:
            # `args.server` is already normalised to an environment token by
            # main(); normalising a second time would turn 'development' back
            # into None and silently resolve to production.
            if args.url and not args.server:
                _emit('error', "--url needs --server: re-run with --server dev or --server prod")
                return 2
            return run_json_progress(api_base=args.url, environment=args.server,
                                     restart_service=not args.no_service_restart)
        if args.leave:
            return run_leave_site()
        if args.report_issue is not None:
            return run_report_issue(args.report_issue)
        if args.reboot_now:
            return run_reboot_now()
        if args.preseed:
            return run_preseed()
        return run_dismiss_reboot()
    except Exception as e:
        logging.exception("Headless mode failed")
        _emit('error', str(e) or repr(e))
        return 1


def main():
    """Entry point for device code pairing flow."""
    parser = argparse.ArgumentParser(description='owlette Site Configuration')
    parser.add_argument('--url', type=str, default=None,
                        help='API base URL (auto-detected if not specified)')
    parser.add_argument('--server', choices=['dev', 'prod'], default=None,
                        help='Which owlette server to pair with. Required whenever --url is '
                             'given; otherwise the machine keeps the environment its config '
                             'is already bound to.')
    parser.add_argument('--add', type=str, default=None,
                        help='Pre-authorized pairing phrase for silent install')
    parser.add_argument('--no-browser', action='store_true',
                        help="Retained for compatibility with existing deployment scripts; "
                             "no browser is opened on this machine any more. The pairing "
                             "link is printed and polling starts either way. "
                             "Also: OWLETTE_NO_BROWSER=1")

    # Headless modes for the desktop app. Mutually exclusive with each other;
    # any one of them replaces the interactive flow entirely.
    parser.add_argument('--json-progress', action='store_true',
                        help='Pair headlessly, emitting JSON progress lines on stdout.')
    parser.add_argument('--leave', action='store_true',
                        help='Leave the current site and deregister this machine.')
    parser.add_argument('--report-issue', type=str, default=None, metavar='PAYLOAD',
                        help='Submit the feedback payload in PAYLOAD (JSON file, deleted after read).')
    parser.add_argument('--reboot-now', action='store_true',
                        help='Record an owlette-initiated reboot and restart the machine.')
    parser.add_argument('--dismiss-reboot', action='store_true',
                        help="Clear this machine's cloud rebootPending flag.")
    parser.add_argument('--no-service-restart', action='store_true',
                        help='With --json-progress, leave the agent running once the '
                             'machine is paired rather than restarting it. The '
                             "daemon's own pairing child runs inside the service it "
                             'would otherwise stop.')
    parser.add_argument('--preseed', action='store_true',
                        help=f'Pair from the preseed a POSIX package left at '
                             f'{PRESEED_PATH} in the data root, or from '
                             f'{PRESEED_ENV_VAR} in the environment.')

    args = parser.parse_args()

    # The ONLY place --server is normalised. argparse's choices already reject
    # every other token; a second pass would map the normalised 'development'
    # back to None, fall through to the config's environment, and resolve a
    # never-paired machine to production.
    args.server = {'dev': 'development', 'prod': 'production'}.get(args.server)

    headless_exit_code = _run_headless_mode(args)
    if headless_exit_code is not None:
        return headless_exit_code

    # --url is a pure API-base override: it no longer implies an environment, so
    # without --server this would write a production project_id for a dev URL.
    if args.url and not args.server:
        print("--url needs --server: re-run with --server dev or --server prod.")
        return 2

    api_base = args.url

    # Retained for compatibility with existing deployment scripts; no browser is
    # opened on this machine any more. Recorded in the debug log so a support
    # case can still tell what the operator passed.
    no_browser = args.no_browser or os.environ.get('OWLETTE_NO_BROWSER', '').strip().lower() in ('1', 'true', 'yes')

    debug_log = Path(shared_utils.get_data_path('logs/pairing_debug.log'))
    Path(shared_utils.get_data_path('logs')).mkdir(parents=True, exist_ok=True)
    with open(debug_log, 'w') as f:
        f.write(f"Pairing Flow Debug\n")
        f.write(f"==================\n")
        f.write(f"--url: {args.url}\n")
        f.write(f"--add: {args.add}\n")
        f.write(f"--no-browser: {no_browser}\n")
        f.write(f"Resolved api_base: {api_base}\n")
        f.write(f"--server: {args.server or 'NOT SET'}\n\n")

    success, message, site_id = run_pairing_flow(
        api_base=api_base,
        environment=args.server,
        add_phrase=args.add,
        show_prompts=True,
    )

    if success:
        print("  this machine is paired — the owlette service is installed and running.")
        return 0
    else:
        # Never block: this console can run with the installer wizard holding the
        # foreground, where a keypress may never reach it. Both recovery routes
        # are printed instead, matching the installer's message box.
        print("  pairing did not complete. to finish it, either:")
        print("    - open owlette from the start menu and choose \"join a site\", or")
        print("    - re-run this script with --server <dev|prod>.")
        return 1


if __name__ == '__main__':
    sys.exit(main())
