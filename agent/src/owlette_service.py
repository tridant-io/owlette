import os
import stat
import sys
import threading
import socket
import requests

# Add the src directory to Python path so imports work when running as service
src_dir = os.path.dirname(os.path.abspath(__file__))
if src_dir not in sys.path:
    sys.path.insert(0, src_dir)

import osadapter
import shared_utils
import installer_utils
import reboot_state
import session_state
import watchdog_state
import config_sync
import configure_site
from command_router import COMMAND_DEFERRED, CommandRouter
from screenshot_capture import ScreenshotCaptureError, capture_and_upload
from concurrent.futures import ThreadPoolExecutor, TimeoutError as FuturesTimeoutError
import logging
import psutil
import time
import json
import datetime
import atexit
import base64
import re
import shlex
import subprocess
import tempfile

try:
    from firebase_client import FirebaseClient
    FIREBASE_AVAILABLE = True
except ImportError:
    FIREBASE_AVAILABLE = False
    # Note: logging not initialized yet, so we can't log here

# Health probe (stdlib-only module, safe to import unconditionally)
from health_probe import HealthState, STATUS_OK

# Error monitoring (optional, no-ops if not configured)
import sentry_utils


def _handle_unhandled_exception(exc_type, exc_value, exc_tb):
    """Log unhandled exceptions before the service host restarts the agent."""
    if issubclass(exc_type, KeyboardInterrupt):
        sys.__excepthook__(exc_type, exc_value, exc_tb)
        return
    logging.critical(
        "UNHANDLED EXCEPTION — the service host will restart the agent:",
        exc_info=(exc_type, exc_value, exc_tb)
    )
    sentry_utils.capture_exception((exc_type, exc_value, exc_tb))
    sentry_utils.flush(timeout=2)


def _handle_thread_exception(args):
    """Log unhandled exceptions from non-main threads."""
    logging.critical(
        f"UNHANDLED THREAD EXCEPTION in {args.thread!r}:",
        exc_info=(args.exc_type, args.exc_value, args.exc_traceback)
    )
    sentry_utils.capture_exception((args.exc_type, args.exc_value, args.exc_traceback))


MAX_RELAUNCH_ATTEMPTS = 3
SLEEP_INTERVAL = 5
TIME_TO_INIT = 60

# Marker the desktop app writes to tmp/app_states.json just before terminating a
# PID for the operator. It has no Firebase client, so without this the service
# would read the vanished PID as a `process_crash`; KILLED would silence the
# alert but also lose the audit trail. Read in handle_process().
PROCESS_RESTARTING_STATUS = 'RESTARTING'

# How long a launched restart prompt counts as still on screen. The prompt is now
# a window inside the desktop app, which the service cannot scan for, so this is
# deliberately generous — it only suppresses duplicate prompts, and
# _handle_dismiss_reboot_pending clears it on an admin dismiss.
RESTART_PROMPT_ACTIVE_SECONDS = 300

# Throttle for _write_service_status(). Main loop calls it every SLEEP_INTERVAL;
# the GUI treats the file as stale after 120s, so a 30s refresh floor is safe
# and cuts ~83% of writes when content is unchanged.
MIN_STATUS_WRITE_INTERVAL = 30

# The agent's ONLY shutdown signal: owlette-host reports STOP_PENDING and waits
# precisely so this poll sees it. NSSM's best-effort console Control-C could fail
# to attach and deliver nothing — the agent was terminated without flushing
# `online: false` (incident 2026-08-13 14:17, the reason the host exists).
SCM_STOP_POLL_INTERVAL = 0.25

# config.json mtime poll. A no-change tick is a single stat, so this can run far
# faster than the 5s main loop it used to ride — detection was costing up to a
# full tick before an operator's edit even began uploading.
LOCAL_CONFIG_POLL_INTERVAL = 0.5

# Shutdown budget once STOP_PENDING appears; overruns log a warning. MUST stay in
# step with supervisor::CHILD_STOP_GRACE in agent/host, which terminates us after
# exactly this long.
SCM_STOP_GRACE_SECONDS = 20.0

# owlette-host writes this the instant an SCM stop/shutdown/preshutdown control
# arrives, so the stop is visible even when the SCM itself cannot be queried.
# EXISTENCE is the signal; the body ({"control": ..., "written_at_ms": ...}) is
# best-effort context for the log and may be partial or unreadable.
STOP_SENTINEL_PATH = shared_utils.get_data_path('tmp/stop_signal.json')

# Corroborating-shutdown search window, both sides anchored on the agent's LAST
# HEARTBEAT — never on boot time. Anchoring the far edge on boot would let an
# unrelated clean reboot hours later vouch for a crash and hide the outage
# between them. The lead covers the agent dying early in a shutdown; the trail is
# generous because 6006 can follow shutdown initiation by minutes on an
# update-heavy stop, and the cost of it being too tight is only a missed
# corroboration (fail-closed to unexpected_reboot).
SHUTDOWN_EVIDENCE_LEAD_SECONDS = 180
SHUTDOWN_EVIDENCE_TRAIL_SECONDS = 600


def _init_status_writer_logger():
    """Build a dedicated rotating logger for status-write decisions.

    Writes to tmp/status_writer.log (100KB x 2 backups = 300KB max). Kept
    separate from the main service log so signal-to-noise stays high and any
    future regression in the throttle is diagnosable from one file.
    """
    import logging.handlers
    log_path = shared_utils.get_data_path('tmp/status_writer.log')
    os.makedirs(os.path.dirname(log_path), exist_ok=True)
    logger = logging.getLogger('owlette.status_writer')
    if getattr(logger, '_owlette_initialized', False):
        return logger
    logger.setLevel(logging.INFO)
    logger.propagate = False  # don't spam main service log
    handler = logging.handlers.RotatingFileHandler(
        log_path, maxBytes=100 * 1024, backupCount=2
    )
    handler.setFormatter(logging.Formatter('%(asctime)s %(message)s'))
    logger.addHandler(handler)
    logger._owlette_initialized = True
    return logger


_status_writer_logger = None

# Reboot scheduler — derived from SLEEP_INTERVAL so changes to the main loop
# automatically adjust the check cadence. Target: ~30s between checks.
REBOOT_CHECK_INTERVAL_SECONDS = 30
REBOOT_CHECK_ITERATIONS = max(1, REBOOT_CHECK_INTERVAL_SECONDS // SLEEP_INTERVAL)
# Display topology check, derived from SLEEP_INTERVAL. Signature hashing is
# cheap; the Firestore upload rides firebase_client's own metrics loop.
DISPLAY_CHECK_INTERVAL_SECONDS = 30
DISPLAY_CHECK_ITERATIONS = max(1, DISPLAY_CHECK_INTERVAL_SECONDS // SLEEP_INTERVAL)
# roost on-disk scrub cadence. The check is a cheap SyncState query; the re-hash
# only fires when last_scrub_at exceeds the 30-day max-age, on a daemon thread so
# the 5-second main loop never stalls.
ROOST_SCRUB_CHECK_INTERVAL_SECONDS = 3600
ROOST_SCRUB_CHECK_ITERATIONS = max(1, ROOST_SCRUB_CHECK_INTERVAL_SECONDS // SLEEP_INTERVAL)
# A scheduled instant older than this is MISSED: skipped and marked fired for the
# day. Prevents a catastrophic late reboot after a restart, deploy or schedule
# edit.
REBOOT_MISSED_FIRE_GRACE_SECONDS = 5 * 60
# Gap between announcing the reboot to Firestore and issuing the OS shutdown, so
# the dashboard countdown renders BEFORE the Windows toast — cancel first.
REBOOT_ANNOUNCE_PREROLL_SECONDS = 5
# `shutdown /r /t` countdown. The main loop stays alive through it and still
# processes cancels (dashboard, or `shutdown /a`).
REBOOT_OS_COUNTDOWN_SECONDS = 60
# A boot found within this window after a scheduled instant counts as
# fulfilling that entry (retroactive lastFiredByEntry stamp).
REBOOT_SUCCESS_DETECTION_WINDOW_SECONDS = 60 * 60


def _display_error_result(result):
    """Render a display_manager failure as an "Error: ..." string."""
    err = (
        result.get('error', 'unknown')
        if isinstance(result, dict) else str(result)
    )
    # Prefixed with the failure code so the dashboard can show a
    # targeted toast instead of "recall failed".
    code = result.get('code') if isinstance(result, dict) else None
    if code:
        return f"Error: {code}: {err}"
    return f"Error: {err}"


def _inherit_identity_extra(pid):
    """Row fields that turn a successful adoption into an INHERIT (D1).

    Managed-or-inherited is the whole rule: a pid owlette did not launch may
    be bound to an entry only once its identity is captured, because every
    later destructive path proves (pid, create_time) before acting -- binding
    without a record would recreate exactly the unverifiable-kill-target
    problem this release closes. Returns the extra-fields dict for
    update_process_status_in_json's row merge (same shape the launch-success
    write records, origin aside), or None when the identity cannot be read --
    the process died between the match and this read -- in which case the
    caller MUST decline the bind and let its normal no-match path continue
    (typically a fresh launch, per D3).
    """
    identity = shared_utils.read_process_identity(pid)
    if identity is None:
        logging.info(
            f"Declining to adopt PID {pid}: process exited between the match "
            f"and the identity read - treating as no match")
        return None
    return {
        'create_time': identity['create_time'],
        'exe': identity['exe'],
        'managed': True,
        'origin': 'inherited',
    }


def _drop_identity_row(pid):
    """Remove a pid row whose record no longer describes any live process.

    Called by the identity gate when a recorded (pid, create_time) fails
    verification: the recorded process is gone and the pid may have been
    recycled, so the stale row must never survive to feed a later kill.
    Read-modify-write matches update_process_status_in_json's own pattern.
    """
    try:
        states = shared_utils.read_json_from_file(shared_utils.RESULT_FILE_PATH)
        if isinstance(states, dict) and str(pid) in states:
            del states[str(pid)]
            shared_utils.write_json_to_file(states, shared_utils.RESULT_FILE_PATH)
    except Exception as e:
        logging.warning(f"Could not remove stale identity row for PID {pid}: {e}")


# Statuses that assert the pid's process is alive RIGHT NOW. Both UIs render an
# app_states row verbatim -- the desktop through LIVE_STATUSES
# (desktop/src/lib/processStatus.ts) and the dashboard through
# get_system_metrics -- so a row in one of these that outlives its pid is a dead
# process showing green.
_LIVE_CLAIM_STATUSES = frozenset({'RUNNING', 'LAUNCHING', 'STALLED'})


def _pid_still_ours(pid, row):
    """True while `pid` is alive AND is still the process `row` recorded.

    Bare pid_exists is not enough for the stale-row sweep: Windows recycles
    pids, so a row whose process is long gone can be held alive indefinitely by
    an unrelated process that inherited its number -- and the entry goes on
    reading green forever rather than for one cleanup interval.

    Rows written before identity records existed carry no create_time and have
    nothing to verify, so they keep the old liveness rule instead of being swept
    on a technicality.
    """
    if not psutil.pid_exists(pid):
        return False
    if not isinstance(row, dict) or not row.get('create_time'):
        return True
    return shared_utils.identity_matches({**row, 'pid': pid}, pid)


def _retire_dead_status_row(service, pid, process_list_id):
    """Drop the app_states row for a dead pid that nothing is going to replace.

    The service writes a status when it LAUNCHES a process and when it
    deliberately stops one, but never when a process dies on its own: the
    relaunch's new row is what normally supersedes the old one. So the stale row
    is only ever corrected as a SIDE EFFECT of relaunching, and where the
    relaunch is declined -- launch mode switched off mid-tick, a scheduled entry
    now outside its window -- the RUNNING row outlives its process and both UIs
    keep the entry green until cleanup_stale_tracking_data sweeps it up to five
    minutes later.

    Called only from that declined-relaunch bail, never from the dead-pid branch
    at large: a relaunch that is ATTEMPTED needs the dead generation's row to
    still be there, because _surface_launch_failed writes LAUNCH_FAILED onto it
    when the attempt fails (D5) and a failed launch has no live pid of its own to
    key a new row by.

    Only rows still CLAIMING life are retired. 'KILLED' is already terminal,
    'LAUNCH_FAILED' is that D5 surfacing row, and 'RESTARTING' is the marker
    _relaunch_if_restarting needs to honour an operator restart of a process
    whose launch mode is off.
    """
    if pid is None:
        return
    try:
        states = shared_utils.read_json_from_file(shared_utils.RESULT_FILE_PATH)
    except Exception as e:
        logging.warning(f"Could not read app_states to retire PID {pid}: {e}")
        return
    row = states.get(str(pid)) if isinstance(states, dict) else None
    process_status = row.get('status') if isinstance(row, dict) else None
    if process_status not in _LIVE_CLAIM_STATUSES:
        return
    _drop_identity_row(pid)
    # Out of the in-memory snapshot as well: the main loop re-reads app_states
    # at the top of each tick, but cleanup_stale_tracking_data writes
    # self.results back wholesale later in THIS one and would restore the row we
    # just deleted.
    if isinstance(getattr(service, 'results', None), dict):
        service.results.pop(str(pid), None)
    logging.info(
        f"Retired stale '{process_status}' row for PID {pid} "
        f"('{process_list_id}') - the process is no longer running")


def _retire_dead_rows_for_entry(service, process_id):
    """Retire every row bound to `process_id` that still claims life on a dead pid.

    The per-tick counterpart to the retirement in handle_process, and the one that
    covers the reported repro. The main loop routes an entry by the launch mode it
    reads at the TOP of the tick, so the moment the mode reads 'off' the entry
    stops reaching handle_process at all and the bail in there is unreachable for
    it. Kill a process by hand and switch it off before the next tick -- which is
    the whole repro -- and the off-mode path is the only one the entry still
    takes, so this is the only place left to notice.

    Same status rule as _retire_dead_status_row: only RUNNING/LAUNCHING/STALLED,
    the ones asserting the process is alive. RESTARTING in particular must
    survive -- its pid is dead BY DESIGN while the caller waits to relaunch it.
    """
    try:
        states = shared_utils.read_json_from_file(shared_utils.RESULT_FILE_PATH)
    except Exception as e:
        logging.warning(f"Could not read app_states to retire rows for '{process_id}': {e}")
        return
    if not isinstance(states, dict):
        return

    # Candidates come from the FILE, not `service.results`: this also runs off
    # the main loop (a remote config apply, a set_launch_mode command), where
    # that snapshot is whatever the last tick read and may not hold the row at
    # all. The file is the authority, and read-modify-write is how every other
    # writer here touches it.
    doomed = [
        pid_str for pid_str, row in states.items()
        if isinstance(row, dict)
        and row.get('id') == process_id
        and row.get('status') in _LIVE_CLAIM_STATUSES
        and pid_str.isdigit()
        and not _pid_still_ours(int(pid_str), row)
    ]
    if not doomed:
        return

    for pid_str in doomed:
        states.pop(pid_str, None)
    try:
        shared_utils.write_json_to_file(states, shared_utils.RESULT_FILE_PATH)
    except Exception as e:
        logging.warning(f"Could not retire stale rows for '{process_id}': {e}")
        return
    # And out of the tick's in-memory snapshot, which cleanup_stale_tracking_data
    # writes back wholesale and would otherwise restore.
    if isinstance(getattr(service, 'results', None), dict):
        for pid_str in doomed:
            service.results.pop(pid_str, None)
    logging.info(
        f"Retired stale row(s) for '{process_id}' (PID {', '.join(doomed)}) "
        f"- the process is no longer running")


def _surface_launch_failed(process_list_id, pid=None):
    """Write LAUNCH_FAILED where the desktop and web will actually show it (D5).

    Both UIs have rendered this status for years (red dot, "failed"); nothing
    ever wrote it. A failed launch or an identity-refused operation was an
    Error: string in a log while the entry's dot sat at the hollow INACTIVE
    ring - indistinguishable from launch-mode-off. Returns True when a row
    was (or already is) surfaced, False when the entry has nothing to surface
    on.

    THE NO-PID PROBLEM (WHY a row is REUSED, never fabricated): a failed
    launch has no live pid to key a fresh row by, and every top-level key in
    app_states.json must stay a numeric pid string - the desktop parser
    (parseAppStates) prunes non-numeric keys and persists the pruned document
    (D2's rule), and a fabricated numeric pid would collide with a real
    process the moment Windows hands that number out. So the status lands on
    a row that already exists:
      - the refused pid's own row, when the caller names one still bound to
        this entry (an identity refusal marks the row involved; a row bound
        to a DIFFERENT entry is never touched - defacing it would show
        "failed" on a healthy neighbour);
      - otherwise the entry's newest existing row, a dead generation from a
        previous launch. statusForProcess falls back to INACTIVE only when
        NO row carries the entry's id (verified against processStatus.ts),
        so the newest dead row surfaces the failure for every entry that has
        ever launched.
    The unreachable case is an entry that has NEVER produced a row: it
    stays INACTIVE. For a blank exe_path the desktop's
    launchModeBlockedReason copy explains why next to the entry; a path
    that is present but broken from creation stays INACTIVE with only the
    log and the Error: command result to say why - the cost of never
    fabricating a row (accepted above over colliding with a recycled pid).

    Identity fields are STRIPPED from the reused row: the record described a
    process that is gone, and a stale record would have the row dropped as
    recycled at the next service restart or by the gate - while recordless
    rows are the ones recovery deliberately keeps. Sibling LAUNCH_FAILED
    rows of the same entry are folded into the target so repeated failures
    never accumulate rows.

    Clearing is the existing write paths' behaviour (verified, pinned in
    test_launch_failed.py): a bind to the same pid overwrites the row's
    status; a bind to a new pid writes a newer-timestamped row that wins the
    desktop's recency sort immediately, and the stale-row sweep clears the
    leftover once the entry has a live row again. Module-level for the same
    descriptor-binding reason as _inherit_identity_extra.
    """
    if not process_list_id:
        return False
    try:
        states = shared_utils.read_json_from_file(shared_utils.RESULT_FILE_PATH)
        if not isinstance(states, dict):
            states = {}
        target_key = None
        if pid is not None:
            row = states.get(str(pid))
            if isinstance(row, dict) and row.get('id') == process_list_id:
                target_key = str(pid)
        if target_key is None:
            candidates = []
            for pid_str, row in states.items():
                if not isinstance(row, dict) or row.get('id') != process_list_id:
                    continue
                try:
                    row_pid = int(pid_str)
                except (TypeError, ValueError):
                    continue
                candidates.append((row.get('timestamp') or 0, row_pid))
            if candidates:
                # Newest generation, ties to the higher pid - the same order
                # the desktop's recency sort resolves a display winner by.
                candidates.sort()
                target_key = str(candidates[-1][1])
        if target_key is None:
            return False
        row = states.get(target_key)
        row = dict(row) if isinstance(row, dict) else {}
        new_row = {k: v for k, v in row.items()
                   if k not in ('create_time', 'exe', 'managed', 'origin')}
        new_row['status'] = 'LAUNCH_FAILED'
        new_row['id'] = process_list_id
        siblings = [k for k, v in states.items()
                    if k != target_key and isinstance(v, dict)
                    and v.get('id') == process_list_id
                    and v.get('status') == 'LAUNCH_FAILED']
        if new_row == row and not siblings:
            return True  # already surfaced - repeat failures are a no-op
        states[target_key] = new_row
        for key in siblings:
            del states[key]
        shared_utils.write_json_to_file(states, shared_utils.RESULT_FILE_PATH)
        return True
    except Exception as e:
        # Surfacing must never turn a failure path into a crash.
        logging.warning(
            f"Could not surface LAUNCH_FAILED for entry '{process_list_id}': {e}")
        return False


def _identity_gate(pid, process_list_id):
    """The kill gate (D1): prove `pid` is the process recorded for this entry.

    Every destructive path calls this before a terminate. The entry's
    app_states row for the pid must carry the identity record written at bind
    time (launch or inherit), and identity_matches must prove the live
    process still IS that record. Returns (True, None) when the terminate may
    proceed, else (False, why) -- and the caller must not touch the pid.

    On a mismatch the stale row is also removed (see _drop_identity_row). On
    a missing record the row, if any, is left alone: it is not evidence, but
    it is also not ours to destroy. Module-level rather than a method for the
    same reason as _inherit_identity_extra -- descriptor-bound service
    doubles in the test suites reach it without binding every helper.
    """
    states = shared_utils.read_json_from_file(shared_utils.RESULT_FILE_PATH)
    row = states.get(str(pid)) if isinstance(states, dict) else None
    if not isinstance(row, dict) or 'create_time' not in row:
        return False, 'no identity record - not managed by owlette'
    if process_list_id and row.get('id') != process_list_id:
        # The pid is recorded, but for another entry: killing it under this
        # entry's command would cross-target a different managed process.
        return False, (f"identity record belongs to entry '{row.get('id')}' "
                       f"- not managed under this entry")
    record = {'pid': pid, 'create_time': row.get('create_time'),
              'exe': row.get('exe')}
    if not shared_utils.identity_matches(record, pid):
        _drop_identity_row(pid)
        return False, ('recorded identity does not match the live process '
                       '(recorded process is gone, pid recycled or dead) - '
                       'stale row removed')
    return True, None


def _resolve_recorded_pid(process_list_id):
    """Resolve an entry to a live pid through its durable identity record.

    This is the point of recording identity at bind time: a kill must still
    find its target after a service restart empties last_started -- the
    recovered row IS the tracking. Scans app_states rows bound to the entry,
    keeps only rows whose record identity_matches the live process, and
    returns the newest by launch timestamp. With duplicates-before-
    convergence every verified row is provably owlette's own instance of this
    entry, so preferring the newest is a choice between our own processes,
    never a guess about a stranger. Returns None when no recorded row
    survives verification.
    """
    states = shared_utils.read_json_from_file(shared_utils.RESULT_FILE_PATH)
    if not isinstance(states, dict):
        return None
    verified = []
    for pid_str, row in states.items():
        if not isinstance(row, dict) or row.get('id') != process_list_id:
            continue
        if 'create_time' not in row:
            continue
        try:
            pid = int(pid_str)
        except (TypeError, ValueError):
            continue
        record = {'pid': pid, 'create_time': row.get('create_time'),
                  'exe': row.get('exe')}
        if shared_utils.identity_matches(record, pid):
            verified.append((row.get('timestamp') or 0, pid))
    if not verified:
        return None
    verified.sort()
    return verified[-1][1]


def _discovered_pid_identity_ok(pid, process):
    """Gate a strict-discovery hit on a command kill path.

    A discovered pid has no durable record BY DEFINITION -- a recorded pid
    would have resolved through _resolve_recorded_pid before discovery ran.
    Strict-unique-match is the same evidence bar an inherit accepts
    (_adopt_running_instance), so the kill applies that bar AT THIS MOMENT:
    read the live identity exactly like _inherit_identity_extra does, and
    refuse if it cannot be read or the live image is not the one the entry
    configures. No record is written -- a record exists to re-verify a
    process LATER, and a pid being terminated has no later; writing one
    would only leave a stale row behind.

    The image check compares basenames, matching the discovery ladder's own
    tier-1 semantics (a file-association launch of a different build of the
    same exe still resolves); a .bat/.cmd entry's discovered pid is its
    cmd.exe wrapper, so cmd.exe IS the expected image there.
    """
    identity = shared_utils.read_process_identity(pid)
    if identity is None:
        return False
    exe_path = (process.get('exe_path') or '').replace('/', '\\').lower()
    live_basename = os.path.basename(identity['exe'])
    if exe_path.endswith(('.bat', '.cmd')):
        return live_basename == 'cmd.exe'
    return bool(exe_path) and live_basename == os.path.basename(exe_path)


def _resolve_kill_target(service, process):
    """Resolve and identity-gate the pid a kill/stop command acts on.

    Returns (pid, note, refusal):
      pid     -- a live, identity-verified pid to terminate, or None
      note    -- provenance suffix for the success message ('' for tracked)
      refusal -- reason string (naming the entry, the pid and why) when the
                 command must fail; None with pid=None simply means the
                 process is not running.

    Resolution order mirrors the strength of the evidence:
      1. the tracked pid (last_started), proven against its recorded row;
      2. the durable identity record -- the whole point of the record: a
         kill still finds its target after a restart emptied tracking;
      3. strict discovery, gated on identity read at this moment (the same
         evidence bar an inherit applies) -- _discovered_pid_identity_ok.
    A tracked pid that fails its gate refuses OUTRIGHT rather than falling
    through: tracking that lies is a state problem the refusal surfaces, and
    silently retargeting a kill would hide it. The refusal clears the
    entry's tracking so the monitor loop re-establishes reality (D3).
    """
    process_list_id = process['id']
    process_name = process.get('name') or process_list_id
    last_pid = service.last_started.get(process_list_id, {}).get('pid')
    if last_pid and Util.is_pid_running(last_pid):
        allowed, why = _identity_gate(last_pid, process_list_id)
        if not allowed:
            if service.last_started.get(process_list_id, {}).get('pid') == last_pid:
                service.last_started.pop(process_list_id, None)
            # D5: the refusal must be visible locally, not just in the
            # command's Error: string. The row involved gets the status; a
            # mismatch already dropped its row, so this falls back to the
            # entry's newest remaining row (or surfaces nothing).
            _surface_launch_failed(process_list_id, pid=last_pid)
            return None, '', (f"refusing to kill '{process_name}' "
                              f"(PID {last_pid}): {why}")
        return last_pid, '', None
    recorded_pid = _resolve_recorded_pid(process_list_id)
    if recorded_pid:
        return recorded_pid, ' (PID resolved from durable identity record)', None
    exe_path = process.get('exe_path', '')
    fallback_pid = (
        service._find_running_process_by_exe(
            exe_path, process.get('file_path', ''), strict=True)
        if exe_path else None)
    if fallback_pid:
        if not _discovered_pid_identity_ok(fallback_pid, process):
            # D5: a discovered pid has no row, so this lands on the entry's
            # newest dead generation when one exists.
            _surface_launch_failed(process_list_id, pid=fallback_pid)
            return None, '', (
                f"refusing to kill '{process_name}' (PID {fallback_pid}): "
                f"discovered pid's identity is unreadable or its image is "
                f"not the entry's executable - not managed by owlette")
        return fallback_pid, ' (PID discovered by exe/file_path lookup)', None
    return None, '', None


def _schedule_stop_allowed(pid, process):
    """Gate the schedule-window stop. Returns (True, None) or (False, why).

    A recorded row takes the uniform gate (mismatch refuses and cleans). A
    tracked pid WITHOUT a record cannot arise from any production bind --
    launch, inherit and recovery all write the record before tracking -- so
    it is legacy in-memory state from before this release. For that one case
    the best evidence available is read at this moment: the live image must
    equal the entry's configured exe_path exactly (normalised); anything
    less refuses. That keeps a pre-3.3.0 mid-session stop working across the
    upgrade while still refusing a recycled pid wearing a different image.
    (A recordless .bat wrapper can never pass -- cmd.exe never equals the
    script path -- which is deliberate: such a wrapper is unattributable.)
    """
    states = shared_utils.read_json_from_file(shared_utils.RESULT_FILE_PATH)
    row = states.get(str(pid)) if isinstance(states, dict) else None
    if isinstance(row, dict) and 'create_time' in row:
        return _identity_gate(pid, process.get('id'))
    identity = shared_utils.read_process_identity(pid)
    if identity is None:
        return False, 'identity unreadable - refusing to stop an unverifiable pid'
    expected = (process.get('exe_path') or '').replace('/', '\\').lower()
    if not expected or identity['exe'] != expected:
        return False, (f"recordless tracked pid runs '{identity['exe']}', not "
                       f"the entry's configured executable - not managed by owlette")
    logging.warning(
        f"Schedule stop of PID {pid} proceeding on live image evidence only "
        f"(recordless pre-3.3.0 tracking): exe matches '{identity['exe']}'")
    return True, None


def _stop_process_outside_window(service, process, pid):
    """Stop a scheduled entry whose window closed -- gated, and through
    graceful_terminate, never a raw psutil terminate.

    graceful_terminate (WM_CLOSE first; exe_path so a .bat wrapper's payload
    is reaped) replaces the old bare terminate, which skipped both the polite
    close and the wrapper-child reaping. A refusal clears the entry's
    tracking: the tracked pid is provably not (or no longer provably) the
    managed process, repeating the same warning every loop tick helps
    nobody, and with the window closed the loop cannot relaunch. Module-level
    for the same descriptor-binding reason as _inherit_identity_extra.
    """
    process_id = process.get('id')
    process_name = process.get('name')
    if not Util.is_pid_running(pid):
        # Already gone: same outcome as the old NoSuchProcess arm -- leave
        # tracking to the loop's normal bookkeeping.
        return
    allowed, why = _schedule_stop_allowed(pid, process)
    if not allowed:
        logging.warning(
            f"Refusing schedule-window stop of '{process_name}' (PID {pid}): {why}")
        # D5: with the window closed nothing else will rewrite this entry's
        # status, so the refusal stays visible until the operator acts or
        # the window reopens.
        _surface_launch_failed(process_id, pid=pid)
        service.last_started.pop(process_id, None)
        return
    try:
        shared_utils.graceful_terminate(pid, exe_path=process.get('exe_path'))
        logging.info(f"Stopped '{process_name}' (PID {pid}) - outside schedule window")
        if service.firebase_client and service.firebase_client.is_connected():
            service.firebase_client.log_event(
                action='process_killed',
                level='info',
                process_name=process_name,
                details=f'Stopped by schedule (outside active window) - PID {pid}'
            )
        service.last_started.pop(process_id, None)
    except psutil.AccessDenied:
        # Old behaviour: keep tracking and retry on a later tick.
        logging.warning(
            f"Access denied stopping '{process_name}' (PID {pid}) outside "
            f"schedule window")


class Util:

    @staticmethod
    def initialize_results_file():
        with open(shared_utils.RESULT_FILE_PATH, 'w') as f:
            json.dump({}, f)

    @staticmethod
    def is_pid_running(pid):
        """True while `pid` names a live process.

        On POSIX a zombie is not one: a managed process the daemon spawned keeps
        its pid until it is reaped, and reading that as "still running" leaves a
        crashed application unrelaunched. _is_tray_alive draws the same line for
        the desktop app. Windows has no such state, so there the pid is the
        whole answer.
        """
        if not psutil.pid_exists(pid):
            return False
        if sys.platform == 'win32':
            return True
        try:
            return psutil.Process(pid).status() != psutil.STATUS_ZOMBIE
        except psutil.NoSuchProcess:
            return False
        except psutil.AccessDenied:
            return True

    @staticmethod
    def get_process_name(process):
        return process.get('name', 'Error retrieving process name')


class OwletteService:

    def _init_state(self):
        """Every attribute main() and its helpers read, set in one place.

        owlette_runner builds the service with object.__new__ and calls this —
        it owns the startup sequence itself — so this is the one place new
        service state may be added. Split the two and the hosted path dies with
        AttributeError in production. Beyond the attributes it reads the api
        base out of config.json and registers the command-router handlers;
        nothing else here touches the network or the disk.
        """
        self._service_start_time = time.time()
        # Replaced by the startup probe in both construction paths.
        self._health_state = None
        self._api_base = shared_utils.read_config(['firebase', 'api_base']) or shared_utils.get_api_base_url()

        # _write_service_status throttle; initialised so the first call is always
        # refresh-due. That method also hasattr-guards, for callers that
        # reach it before _init_state.
        self._last_status_signature = None
        self._last_status_write_time = 0.0

        # Once-only guard for graceful_shutdown(). The console handler and the
        # SCM watcher can both fire for the same stop, and neither is allowed to
        # log agent_stopped twice or race the Firestore offline write.
        self._shutdown_lock = threading.Lock()
        self._shutdown_trigger = None

        # Per-process launch serialisation. The monitor loop, slow-command worker
        # and config listener all launch, and "not running" + "launch" was not
        # atomic, so two could double-launch. Keyed per process so one launch
        # can't stall other monitoring; RLock because kill_and_relaunch_process
        # holds it across terminate+launch.
        self._launch_locks = {}
        self._launch_locks_guard = threading.Lock()
        # Earliest time.monotonic() at which the main loop's Case-4 recovery
        # (Firebase enabled but no running client) may try a reinit. Armed to
        # now+300s after each failed attempt.
        self._firebase_reinit_not_before = 0.0
        # ConnectionManager the status-file listener is registered against, so
        # re-initialising the Firebase client re-wires it against the new one.
        self._connection_status_manager = None
        # Local-config push detection. The mtime is the cheap gate the config
        # watcher checks twice a second; None means "no baseline yet, compare
        # properly".
        # _applying_remote_config suppresses detection while a pull is writing
        # config.json, so a pull is never mistaken for a local edit.
        self._local_config_mtime = None
        self._applying_remote_config = False
        self._config_push_thread = None
        # Serialises the two writers of _local_config_mtime — the push thread and
        # handle_config_update's finally, which a foreign-edit delivery can run
        # concurrently.
        self._config_baseline_lock = threading.Lock()
        # Paces retries of a failing push; _push_attempt_mtime identifies which
        # edit has been failing, so a newer one resets the backoff.
        self._push_backoff = config_sync.PushBackoff()
        self._push_attempt_mtime = None
        # One WARNING per episode when the SCM cannot be queried; DEBUG is off by
        # default, so a blind watcher used to leave no trace at all.
        self._scm_query_failure_logged = False

        self.is_alive = True
        self._restart_exit_code = 0
        self.tray_icon_pid = None
        self.cortex_pid = None
        # time.monotonic() deadline past which a launched reboot-countdown prompt
        # is no longer assumed to be on screen (see _is_restart_prompt_active).
        self._restart_prompt_until = 0.0
        # De-spams the "desktop app not found" warning to one line per episode.
        self._desktop_exe_missing_logged = False
        self.relaunch_attempts = {} # Restart attempts for each process
        self.first_start = True # First start of this service
        self.last_started = {} # Last time a process was started
        self.results = {} # App process response esults
        self.current_time = datetime.datetime.now()
        self.active_installations = {} # Track active installer processes for cancellation
        self.install_locks = {}  # {process_config_id: deployment_id} - suppress relaunch during install
        self.manual_overrides = {} # Processes manually started outside their schedule window
        self._last_seen_launch_modes = {} # Service-owned launch_mode snapshot for transition diffs
        self._last_seen_launch_schedules = {} # Schedule signatures for scheduled-mode edit logging
        self._skip_launch_delay = set()  # Process IDs that should skip time_delay on next launch
        self._cached_site_timezone = None  # Cached from firebase_client
        # Persisted source of truth is reboot_state.py. Monotonic clock so DST/NTP
        # corrections can't trigger false retries.
        self._reboot_attempt_started_monotonic = None
        self._reboot_schedule_counter = 0  # Check reboot schedule every REBOOT_CHECK_ITERATIONS
        # Cached hash suppresses no-op ticks; _cached_display_profile is diffed by
        # edidHash to categorise each real change (add/remove/swap/drift/
        # mosaic_disabled/sync_lost).
        self._display_check_counter = 0
        self._cached_display_hash = None
        self._cached_display_profile = None
        # Consecutive drift ticks. _maybe_auto_restore needs >= 2, so a one-tick
        # flap (cable wiggle) can't trigger an unattended re-apply.
        self._drift_pending_tick_count = 0
        self._drift_pending_key = None
        self._last_auto_restore_success_key = None
        # Ticks toward ROOST_SCRUB_CHECK_ITERATIONS; _roost_scrub_thread keeps the
        # scrub single-flight.
        self._roost_scrub_check_counter = 0
        self._roost_scrub_thread = None
        # Same single-flight shape as _roost_scrub_thread: the Cortex IPC pump
        # runs off-loop because one capture_screenshot takes ~55s.
        self._cortex_ipc_thread = None
        # And again for the POSIX privileged-request seam: a `pair` request
        # starts a ten-minute poll.
        self._privileged_requests_thread = None
        # Single-flight handle for the off-loop reboot-pending check.
        self._reboot_pending_future = None
        self._shutting_down = False  # Suppresses crash alerts during reboot/shutdown
        self._live_view_active = False
        self._live_view_stop_time = 0

        # Checked BEFORE handle_firebase_command's legacy if/elif chain, falling
        # through when a type isn't registered. Register new handlers here.
        self._command_router = CommandRouter()
        # roost handlers run on the caller's thread; their long work is handed to
        # sync_downloader / sync_assembler daemon threads so dispatch stays quick.
        try:
            from sync_commands import register_handlers as _register_roost_handlers
            _register_roost_handlers(self._command_router)
        except Exception as e:
            # Non-fatal — agent still runs v1 commands; v2 commands will return
            # "Unknown command type" until the handlers are loadable.
            logging.warning(f"Failed to register roost handlers: {e}")

        # capture_screenshot now goes through the public signed-URL flow.
        try:
            from machine_commands import register_handlers as _register_machine_handlers
            _register_machine_handlers(self._command_router)
        except Exception as e:
            logging.warning(f"Failed to register machine-api handlers: {e}")

        # restart_process here supersedes the legacy _execute_command branch —
        # the router wins dispatch.
        try:
            from process_commands import register_handlers as _register_process_handlers
            _register_process_handlers(self._command_router)
        except Exception as e:
            logging.warning(f"Failed to register process-control handlers: {e}")

        self.firebase_client = None

    @property
    def _auth_manager(self):
        """The AuthManager the cloud client was built with, or None.

        Read off firebase_client rather than mirrored onto the service: a second
        copy has to be assigned by the startup sequence, and when that
        assignment went missing the health and reboot-pending alerts silently
        stopped firing with nothing to fail on.
        """
        return getattr(self.firebase_client, 'auth_manager', None)

    def _initialize_or_restart_firebase_client(self):
        """
        Initialize or reinitialize Firebase client based on current config.
        Called during startup and when Firebase is re-enabled after being disabled.

        Returns:
            bool: True if Firebase client is successfully initialized/restarted, False otherwise
        """
        try:
            if not FIREBASE_AVAILABLE:
                logging.warning("Firebase module not available - cannot initialize client")
                return False

            firebase_enabled = shared_utils.read_config(['firebase', 'enabled'])
            if not firebase_enabled:
                logging.info("Firebase is disabled in config - skipping initialization")
                return False

            site_id = shared_utils.read_config(['firebase', 'site_id'])
            if not site_id:
                logging.warning("No site_id configured - cannot initialize Firebase client")
                return False

            project_id = shared_utils.read_config(['firebase', 'project_id']) or shared_utils.get_project_id()
            api_base = shared_utils.read_config(['firebase', 'api_base']) or shared_utils.get_api_base_url()
            cache_path = shared_utils.get_data_path('cache/firebase_cache.json')

            logging.info(f"Initializing Firebase client - site: {site_id}, project: {project_id}")

            from auth_manager import AuthManager
            auth_manager = AuthManager(api_base=api_base)

            if not auth_manager.is_authenticated():
                logging.error("Agent not authenticated - no refresh token found")
                logging.error("Please run the installer or re-authenticate via web dashboard")
                return False

            if self.firebase_client:
                logging.debug("Stopping existing Firebase client before reinitialization...")
                try:
                    self.firebase_client.stop()
                    logging.debug("Existing Firebase client stopped")
                except Exception as e:
                    logging.warning(f"Error stopping existing Firebase client: {e}")

            self.firebase_client = FirebaseClient(
                auth_manager=auth_manager,
                project_id=project_id,
                site_id=site_id,
                config_cache_path=cache_path
            )

            self.firebase_client.register_command_callback(self.handle_firebase_command)
            self.firebase_client.register_config_update_callback(self.handle_config_update)

            # Sync config: pull from Firestore (source of truth), or seed if new machine
            sync_result = self.firebase_client.sync_config_on_startup()
            logging.info(f"Config sync on reinit: {sync_result}")

            # Re-wire against the new connection manager and publish the state it
            # already reached in its constructor; the tray polls the file at 1Hz.
            self._wire_connection_status_listener()

            # Wire health callback so connection failures update health state + alert
            self.firebase_client.connection_manager.set_health_callback(
                lambda code, msg: self._update_health_state('connection_failure', code, msg)
            )

            # Wire self-restart watchdog callback BEFORE start() so the watchdog
            # thread (spawned by start) always has a callback registered.
            self.firebase_client.connection_manager.set_restart_callback(
                self._handle_watchdog_restart
            )

            self.firebase_client.start()
            logging.info(f"[OK] Firebase client initialized and started for site: {site_id}")

            # Cache site timezone for schedule evaluation
            self._cached_site_timezone = self.firebase_client.site_timezone

            # Stale health errors are cleared by the connection-status listener,
            # NOT stamped ok here — a re-init whose connect failed must keep its
            # error.

            return True

        except Exception as e:
            logging.error(f"Failed to initialize Firebase client: {e}")
            logging.exception("Firebase initialization error details:")
            self.firebase_client = None
            return False

    def _health_section(self) -> dict:
        """Build the health section for service_status.json from current _health_state."""
        h = getattr(self, '_health_state', None)
        if h is None:
            return {'status': 'unknown', 'checked_at': 0, 'error_code': None, 'error_message': None, 'probe_results': {}}
        return h.to_dict()

    def _write_service_status_early(self, running=True):
        """
        Write service + health sections to service_status.json immediately after
        the startup health probe, before Firebase is initialized.
        This lets the tray icon show health alerts right away.
        """
        try:
            status_path = shared_utils.get_data_path('tmp/service_status.json')
            os.makedirs(os.path.dirname(status_path), exist_ok=True)

            status = {
                'service': {
                    'running': running,
                    'last_update': int(time.time()),
                    'version': shared_utils.APP_VERSION
                },
                'firebase': {
                    'enabled': False,
                    'connected': False,
                    'site_id': '',
                    'site_name': '',
                    # Same shape as the steady-state write: readers must never
                    # have to tell "key absent" from "site opted out".
                    'schedule_timezone': '',
                    'last_heartbeat': 0
                },
                'health': self._health_section()
            }

            temp_path = status_path + '.tmp'
            with open(temp_path, 'w') as f:
                json.dump(status, f, indent=2)
            if os.path.exists(status_path):
                os.remove(status_path)
            os.rename(temp_path, status_path)

        except Exception as e:
            logging.debug(f"Failed to write early service status: {e}")

    def _write_service_status(self, running=True):
        """
        Write current service status to file for tray icon to read.

        Creates/updates C:\\ProgramData\\owlette\\tmp\\service_status.json with:
        - Service running state
        - Firebase enabled/connected state
        - Site ID, and the site's display name when it is known
        - Last heartbeat timestamp
        - Service version
        - Health probe results

        This provides real-time IPC from service → tray icon without log parsing.

        Writes are throttled: skipped if content-relevant fields are unchanged
        AND the refresh floor (MIN_STATUS_WRITE_INTERVAL) hasn't elapsed.
        Every decision is logged to tmp/status_writer.log for diagnosability.

        Args:
            running: Whether service is currently running (False when stopping)
        """
        # A listener callback can fire during connection_manager wiring, before
        # _init_state has set the throttle state.
        if not hasattr(self, '_last_status_signature'):
            self._last_status_signature = None
        if not hasattr(self, '_last_status_write_time'):
            self._last_status_write_time = 0.0

        global _status_writer_logger
        if _status_writer_logger is None:
            try:
                _status_writer_logger = _init_status_writer_logger()
            except Exception:
                _status_writer_logger = logging.getLogger('owlette.status_writer.fallback')

        try:
            status_path = shared_utils.get_data_path('tmp/service_status.json')

            os.makedirs(os.path.dirname(status_path), exist_ok=True)

            firebase_enabled = shared_utils.read_config(['firebase', 'enabled']) or False
            firebase_connected = False
            site_id = ''
            site_name = ''
            schedule_timezone = ''
            last_heartbeat = 0

            if self.firebase_client:
                try:
                    firebase_connected = self.firebase_client.is_connected()
                    site_id = self.firebase_client.site_id or ''
                    # Read off the client, not cached here, so a rename picked up
                    # on reconnect needs no second copy kept in step.
                    site_name = getattr(self.firebase_client, 'site_name', None) or ''
                    # '' means "this site's process windows are machine-local" —
                    # either it never opted in or it opted back out. The desktop
                    # app reads this to know which clock to name in schedule copy.
                    schedule_timezone = getattr(self.firebase_client, 'site_timezone', None) or ''
                    if hasattr(self.firebase_client, '_last_heartbeat_time'):
                        last_heartbeat = int(self.firebase_client._last_heartbeat_time)
                except Exception:
                    pass  # Ignore errors getting Firebase state

            health_section = self._health_section()

            status = {
                'service': {
                    'running': running,
                    'last_update': int(time.time()),
                    'version': shared_utils.APP_VERSION
                },
                'firebase': {
                    'enabled': firebase_enabled,
                    'connected': firebase_connected,
                    'site_id': site_id,
                    'site_name': site_name,
                    'schedule_timezone': schedule_timezone,
                    'last_heartbeat': last_heartbeat
                },
                'health': health_section
            }

            # Excludes timestamps and free-form strings so it only flips on real
            # state changes.
            signature = (
                bool(running),
                bool(firebase_enabled),
                bool(firebase_connected),
                site_id,
                # In the signature so a rename reaches the desktop app on the next
                # tick, not on the 30s refresh floor.
                site_name,
                # Likewise: opting in or out rewrites the schedule copy the
                # desktop app shows, so it must not wait out the refresh floor.
                schedule_timezone,
                health_section.get('status'),
                health_section.get('error_code'),
            )

            now_mono = time.monotonic()
            content_changed = signature != self._last_status_signature
            refresh_due = (now_mono - self._last_status_write_time) >= MIN_STATUS_WRITE_INTERVAL
            should_write = (not running) or content_changed or refresh_due

            if not should_write:
                try:
                    _status_writer_logger.info(
                        f"skip throttled sig={hash(signature) & 0xffffffff:08x}"
                    )
                except Exception:
                    pass
                return

            temp_path = status_path + '.tmp'
            with open(temp_path, 'w') as f:
                json.dump(status, f, indent=2)

            # os.replace() is atomic on Windows (no gap where file is missing)
            os.replace(temp_path, status_path)

            reason = (
                'shutdown' if not running
                else 'content_changed' if content_changed
                else 'refresh_floor'
            )
            self._last_status_signature = signature
            self._last_status_write_time = now_mono
            try:
                _status_writer_logger.info(
                    f"write {reason} sig={hash(signature) & 0xffffffff:08x} "
                    f"connected={firebase_connected} health={health_section.get('status')}"
                )
            except Exception:
                pass

        except Exception as e:
            logging.debug(f"Failed to write service status: {e}")
            try:
                _status_writer_logger.info(f"error {type(e).__name__}: {e}")
            except Exception:
                pass

    def _clear_health_error_on_connect(self):
        """Reset the health state to ok — call only when the connection is live.

        A live Firestore connection disproves every verdict the health state
        can carry: the boot-time probe's config_error / auth_error /
        network_error, and the connection_failure the health callback records
        during an outage. Those are snapshots of a past moment; without this
        reset they outlive the condition they described — a machine that booted
        before DHCP finished kept flashing a red tray icon for the rest of its
        uptime while `firebase.connected` sat true in the same status document
        (TEC-B4A, 2026-08-17). Idempotent: an ok state is left untouched.
        """
        health = getattr(self, '_health_state', None)
        if health is not None and health.status == STATUS_OK:
            return
        self._update_health_state(STATUS_OK, STATUS_OK, 'Connected to owlette cloud')

    def _wire_connection_status_listener(self):
        """Keep tmp/service_status.json in step with the cloud connection.

        The tray reads that file every second and paints the connection badge
        from it, so the file *is* the tray's view of connectivity. A listener on
        its own is not enough to make that view honest: the initial
        CONNECTING -> CONNECTED transition happens inside FirebaseClient's
        constructor, long before main() reaches the point where the listener
        used to be registered — and on a startup whose config sync is slow
        (15s is normal, and it sits between the two) the badge stayed red until
        the first main-loop status write, ~25s after the connection was
        actually established. The immediate write below is what closes that gap.

        The same two moments also settle the health state: a transition to
        CONNECTED — and a manager that is already CONNECTED when the listener
        is wired, which is how the constructor-time connect arrives here —
        clears whatever error the startup probe or a past outage recorded.
        The failure direction is symmetric and already lives on this manager:
        set_health_callback records connection_failure on BACKOFF/FATAL_ERROR.

        Idempotent per connection manager, so _initialize_firebase_client can
        call it again after replacing the client and get the new one wired.
        """
        if not self.firebase_client:
            return

        manager = getattr(self.firebase_client, 'connection_manager', None)
        if manager is None:
            return

        from connection_manager import ConnectionState

        if manager is not self._connection_status_manager:
            def _on_connection_change(event):
                # `connected` is part of the write signature, so a transition
                # always writes while a steady state stays throttled.
                try:
                    if event.new_state == ConnectionState.CONNECTED:
                        self._clear_health_error_on_connect()
                except Exception as e:
                    logging.debug(f"Health clear on connection change failed: {e}")
                try:
                    self._write_service_status()
                except Exception as e:
                    logging.debug(f"Status write on connection change failed: {e}")

            manager.add_state_listener(_on_connection_change)
            self._connection_status_manager = manager

        # Publish the state that is already current — the transition this
        # listener exists for has usually happened by now.
        try:
            if manager.state == ConnectionState.CONNECTED:
                self._clear_health_error_on_connect()
        except Exception as e:
            logging.debug(f"Health clear on listener wire failed: {e}")
        try:
            self._write_service_status()
        except Exception as e:
            logging.debug(f"Initial connection status write failed: {e}")

    def graceful_shutdown(self, trigger):
        """Flush presence and log the shutdown. Runs at most once per process.

        Every operator-initiated stop has to come through here: the machine is
        marked offline in Firestore, an agent_stopped event is logged, the
        session is recorded as a clean external stop, and the status file is
        left saying the service is down.

        Two independent triggers call it — the console control handler, and
        the SCM watcher that notices STOP_PENDING whether or not any console
        event ever arrives. Whichever gets here first does the work; the other
        returns immediately.

        Args:
            trigger: Short name of what noticed the stop, for the log.

        Returns:
            True if this call performed the shutdown, False if it was already
            done (or under way on another thread).
        """
        with self._shutdown_lock:
            if self._shutdown_trigger is not None:
                logging.debug(
                    f"[SHUTDOWN] {trigger} ignored — already handled by "
                    f"{self._shutdown_trigger}"
                )
                return False
            self._shutdown_trigger = trigger

        # FIRST, before anything that can touch the network and regardless of
        # whether Firebase exists: at OS shutdown Windows allows roughly 5s, and
        # this local write is the only record that the stop was clean. Behind the
        # old Firestore log_event it routinely never happened, and the next boot
        # reported unexpected_reboot. Compare-and-set so an owlette_reboot /
        # owlette_shutdown intent set moments earlier still wins.
        try:
            session_state.set_intent_if_none("external_clean")
        except Exception as e:
            logging.debug(f"[SHUTDOWN] set_intent_if_none failed: {e}")

        # Every Firestore call below now has 3s to land instead of 30.
        if self.firebase_client:
            try:
                self.firebase_client.enter_shutdown_mode()
            except Exception as e:
                logging.debug(f"[SHUTDOWN] enter_shutdown_mode failed: {e}")

        started = time.monotonic()
        logging.warning(f"=== SERVICE STOP ({trigger}) === flushing presence")
        self.is_alive = False

        if self.firebase_client:
            try:
                version = shared_utils.get_app_version()
                self.firebase_client.log_event(
                    action='agent_stopped',
                    level='info',
                    details=f'owlette agent v{version} shutting down gracefully'
                )
                logging.info("[SHUTDOWN] agent_stopped event logged")
            except Exception as e:
                logging.error(f"[SHUTDOWN] Failed to log agent_stopped: {e}")

            # This is the write that marks the machine offline.
            try:
                self.firebase_client.stop()
                logging.info("[SHUTDOWN] Firebase client stopped, machine offline")
            except Exception as e:
                logging.error(f"[SHUTDOWN] Error stopping Firebase client: {e}")
        else:
            logging.warning("[SHUTDOWN] No Firebase client — presence not flushed")

        try:
            self._write_service_status(running=False)
        except Exception as e:
            logging.debug(f"[SHUTDOWN] Final status write failed: {e}")

        elapsed = time.monotonic() - started
        if elapsed > SCM_STOP_GRACE_SECONDS:
            logging.warning(
                f"=== SERVICE STOP COMPLETE ({trigger}) === took {elapsed:.1f}s, "
                f"longer than the {SCM_STOP_GRACE_SECONDS}s the service host allows — the "
                f"offline write may not have landed"
            )
        else:
            logging.info(f"=== SERVICE STOP COMPLETE ({trigger}) === in {elapsed:.1f}s")
        return True

    def _log_scm_query_failure(self, message):
        """First failure of an episode at WARNING, repeats at DEBUG.

        Every SCM read error is swallowed as "not stopping", and DEBUG is off by
        default, so a watcher that had gone blind left no trace anywhere.

        getattr backstop: _query_scm_stop_requested is deliberately callable on a
        bare instance so the decision can be exercised without a service.
        """
        if getattr(self, '_scm_query_failure_logged', False):
            logging.debug(f"[SCM WATCH] {message}")
            return
        self._scm_query_failure_logged = True
        logging.warning(
            f"[SCM WATCH] SCM stop watcher cannot query the SCM: {message}; "
            f"relying on the stop sentinel"
        )

    def _query_scm_stop_requested(self):
        """True once the SCM reports this service is stopping.

        Kept separate from the polling loop so the decision can be exercised
        without a service. Any failure to read the SCM is reported as "not
        stopping" — a watcher that cannot see the SCM must not invent a stop.
        """
        import win32service

        try:
            manager = win32service.OpenSCManager(
                None, None, win32service.SC_MANAGER_CONNECT)
        except Exception as e:
            self._log_scm_query_failure(f"could not open the SCM: {e}")
            return False

        try:
            service = win32service.OpenService(
                manager, shared_utils.SERVICE_NAME, win32service.SERVICE_QUERY_STATUS)
        except Exception as e:
            self._log_scm_query_failure(
                f"could not open {shared_utils.SERVICE_NAME}: {e}")
            return False
        finally:
            try:
                win32service.CloseServiceHandle(manager)
            except Exception:
                pass

        try:
            state = win32service.QueryServiceStatus(service)[1]
        except Exception as e:
            self._log_scm_query_failure(f"could not query service status: {e}")
            return False
        finally:
            try:
                win32service.CloseServiceHandle(service)
            except Exception:
                pass

        self._scm_query_failure_logged = False
        return state in (win32service.SERVICE_STOP_PENDING,
                         win32service.SERVICE_STOPPED)

    def _stop_sentinel_written_at(self):
        """Best-effort wall-clock time the sentinel was written, or None.

        File mtime first; written_at_ms only as a fallback, for the case where
        the file is readable but not stat-able.
        """
        try:
            return os.path.getmtime(STOP_SENTINEL_PATH)
        except OSError:
            pass
        try:
            with open(STOP_SENTINEL_PATH, 'r') as f:
                written_ms = json.load(f).get('written_at_ms')
            if isinstance(written_ms, (int, float)) and written_ms > 0:
                return written_ms / 1000.0
        except Exception:
            pass
        return None

    def _read_stop_sentinel(self, reference):
        """Return the control name from owlette-host's stop sentinel, else None.

        Existence is the signal and the body is best-effort context — an
        unreadable or half-written file still reports a stop ('unknown') — but
        only for a sentinel written since `reference` (this process's start).

        Freshness rather than deletion is what makes this safe: a survivor that
        could not be deleted (AV lock, bad ACL) would otherwise be obeyed on the
        watcher's first tick, stopping the service 250ms after every start and
        turning host relaunches into a restart storm.
        """
        try:
            if not os.path.exists(STOP_SENTINEL_PATH):
                return None
        except OSError:
            return None

        written_at = self._stop_sentinel_written_at()
        if written_at is None or written_at < reference:
            return None

        try:
            with open(STOP_SENTINEL_PATH, 'r') as f:
                return str(json.load(f).get('control') or 'unknown')
        except Exception:
            return 'unknown'

    def _clear_stop_sentinel(self, reference):
        """Best-effort removal of a sentinel left by a previous session.

        Only files written before `reference` are removed: python's startup takes
        seconds, and a stop arriving inside that window writes a REAL sentinel
        that must survive to be acted on. Failure is not fatal — the freshness
        check in _read_stop_sentinel is what actually decides.
        """
        try:
            if not os.path.exists(STOP_SENTINEL_PATH):
                return
            written_at = self._stop_sentinel_written_at()
            if written_at is not None and written_at >= reference:
                logging.info(
                    "Stop sentinel was written after this process started — keeping it")
                return
            os.remove(STOP_SENTINEL_PATH)
            logging.info("Cleared stale stop sentinel from the previous session")
        except OSError as e:
            logging.warning(
                f"Could not clear the stale stop sentinel ({e}) — it will be "
                f"ignored as stale rather than obeyed"
            )

    def start_scm_stop_watcher(self):
        """Watch the SCM for a stop this process was never told about.

        NSSM's graceful stop was a console Control-C it could only deliver if it
        managed to attach to the application's console; when that failed the
        agent was terminated with no signal at all, which is how a machine came
        to sit on the dashboard as online with an eleven-minute-old heartbeat.
        STOP_PENDING is set the moment the stop control is accepted and cannot
        be missed — owlette-host reports it and then waits for this shutdown to
        finish — so it is polled here as the trigger that always fires.

        The SCM is not always reachable, so owlette-host also drops a sentinel
        file the moment it accepts the control; that is checked first each tick
        because it costs one stat and cannot fail the way an SCM handle can.

        Runs on its own daemon thread — never on the main loop, which must not
        block — and exits as soon as it has handed off to graceful_shutdown().

        Windows only, and returns None elsewhere: both the SCM it polls and
        the sentinel it stats are owlette-host's, which is never built for
        POSIX — there launchd and systemd deliver a real SIGTERM, which the
        runner's signal handler already answers.
        """
        if sys.platform != 'win32':
            return None

        # Process start, not watcher start: a stop control arriving during
        # python's multi-second startup writes a real sentinel, and anything from
        # before this instant belongs to the previous session.
        reference = getattr(self, '_service_start_time', None) or time.time()

        # Before the thread starts, not in main(): the runner starts this watcher
        # first, so clearing it there would race a survivor into a self-stop.
        self._clear_stop_sentinel(reference)

        def _watch():
            failures = 0
            while self.is_alive:
                try:
                    control = self._read_stop_sentinel(reference)
                    if control is not None:
                        logging.warning(
                            f"[SCM WATCH] Stop sentinel from owlette-host detected "
                            f"(control={control}) — flushing presence now"
                        )
                        self.graceful_shutdown('scm_stop')
                        return
                    if self._query_scm_stop_requested():
                        logging.warning(
                            "[SCM WATCH] Service is stopping and no shutdown "
                            "signal reached us — flushing presence now"
                        )
                        self.graceful_shutdown('scm_stop')
                        return
                    failures = 0
                except Exception as e:
                    failures += 1
                    logging.debug(f"[SCM WATCH] Poll failed ({failures}): {e}")
                    # A watcher that can't read the SCM must not spin forever
                    # logging; the console handler still covers the stop.
                    if failures >= 10:
                        logging.warning(
                            "[SCM WATCH] Giving up after 10 consecutive failures"
                        )
                        return
                time.sleep(SCM_STOP_POLL_INTERVAL)

        thread = threading.Thread(
            target=_watch, name='owlette-scm-stop-watch', daemon=True)
        thread.start()
        logging.info(
            f"SCM stop watcher started (polling every {SCM_STOP_POLL_INTERVAL}s)")
        return thread

    def _update_health_state(self, status: str, error_code: str, message: str):
        """
        Update health state and propagate to IPC file, Firestore (if connected),
        and web API alert endpoint (if auth available and connection failed).

        Called by the ConnectionManager health callback and internal error handlers.
        Never raises — failures are logged at DEBUG level.
        """
        try:
            import time as _time
            if self._health_state is None:
                self._health_state = HealthState(
                    status=status,
                    error_code=error_code,
                    error_message=message,
                    checked_at=int(_time.time())
                )
            else:
                self._health_state.status = status
                self._health_state.error_code = error_code
                self._health_state.error_message = message
                # checked_at is when THIS verdict was reached, not when the
                # boot-time probe ran.
                self._health_state.checked_at = int(_time.time())

            self._write_service_status()
            # Recovery to ok is routine; anything else is worth a warning.
            level = logging.INFO if status == STATUS_OK else logging.WARNING
            logging.log(level, f"[HEALTH] Status updated: {status} — {error_code}: {message}")

        except Exception as e:
            logging.debug(f"_update_health_state write failed: {e}")

        try:
            if self.firebase_client and self.firebase_client.is_connected():
                self.firebase_client.write_health_to_firestore(status, error_code, message)
        except Exception as e:
            logging.debug(f"_update_health_state Firestore write failed: {e}")

        # Send alert to web API in a daemon thread when connection fails but auth is OK
        if status == 'connection_failure' and self._auth_manager:
            def _send_alert():
                try:
                    token = self._auth_manager.get_valid_token()
                    site_id = self._auth_manager.get_site_id() or ''
                    machine_id = shared_utils.get_machine_id()
                    api_base = self._api_base or shared_utils.get_api_base_url()
                    requests.post(
                        f"{api_base}/agent/alert",
                        json={
                            'siteId': site_id,
                            'machineId': machine_id,
                            'errorCode': error_code,
                            'errorMessage': message,
                            'agentVersion': shared_utils.APP_VERSION,
                        },
                        headers={'Authorization': f'Bearer {token}'},
                        timeout=10
                    )
                    logging.info(f"[HEALTH] Alert sent to web API: {error_code}")
                except Exception as e:
                    logging.debug(f"[HEALTH] Web API alert failed (non-critical): {e}")

            t = threading.Thread(target=_send_alert, daemon=True)
            t.start()

    def _submit_reboot_pending_check(self):
        """Hand the reboot-pending check to a worker; never run it on the loop.

        check_pending_reboot shells out to schtasks with a 10s timeout — twice
        the tick — so on the loop thread it stalls every monitor on the machine.
        Single-flight: a check still running when the next 15-minute mark
        arrives is left alone rather than stacked.
        """
        future = self._reboot_pending_future
        if future is not None and not future.done():
            return

        def _run():
            try:
                self._check_and_alert_reboot_pending()
            except Exception as e:
                logging.debug(f"Reboot-pending check failed (non-critical): {e}")

        # Manual lifecycle, like the display-topology pool: shutdown(wait=False)
        # retires the worker once the task finishes without blocking the loop.
        # Dispatch failure is non-critical — a thread-starved machine must not
        # take the main loop down over a 15-minute housekeeping check.
        try:
            pool = ThreadPoolExecutor(max_workers=1, thread_name_prefix='reboot-pending')
            try:
                self._reboot_pending_future = pool.submit(_run)
            finally:
                pool.shutdown(wait=False)
        except Exception as e:
            logging.debug(f"Reboot-pending dispatch failed (non-critical): {e}")

    def _check_and_alert_reboot_pending(self):
        """Background check: detect Windows reboot-pending state and emit a
        site event once per pending-state transition.

        Dispatched every ~15 min by _submit_reboot_pending_check, on a worker
        rather than the loop thread. Uses a flag file to avoid re-alerting every
        15 min for the same pending state; clears the flag once the system is no
        longer pending.
        """
        if not self._auth_manager:
            return

        try:
            import mcp_tools
            status = mcp_tools.check_pending_reboot({}, None)
        except Exception as e:
            logging.debug(f"reboot-pending detection failed: {e}")
            return

        if not isinstance(status, dict):
            return

        pending = bool(status.get('pending'))
        flag_path = shared_utils.get_data_path('tmp/reboot_pending_alerted.flag')

        if not pending:
            try:
                if os.path.exists(flag_path):
                    os.remove(flag_path)
                    logging.info("[REBOOT-PENDING] State cleared — flag removed")
            except Exception:
                pass
            return

        # Pending is true — only alert if we haven't already for this state
        if os.path.exists(flag_path):
            return

        reasons = status.get('reasons', [])
        next_scheduled = status.get('next_scheduled_update') or {}
        logging.warning(f"[REBOOT-PENDING] Detected: reasons={reasons}, emitting alert")

        def _emit_alert():
            try:
                token = self._auth_manager.get_valid_token()
                site_id = self._auth_manager.get_site_id() or ''
                machine_id = shared_utils.get_machine_id()
                api_base = self._api_base or shared_utils.get_api_base_url()
                message = (
                    f"Reboot pending on {shared_utils.get_hostname()} "
                    f"(reasons: {', '.join(reasons) or 'unknown'})"
                )
                if next_scheduled.get('next_run'):
                    message += f" — next scheduled run: {next_scheduled['next_run']}"
                requests.post(
                    f"{api_base}/agent/alert",
                    json={
                        'siteId': site_id,
                        'machineId': machine_id,
                        'errorCode': 'reboot_pending',
                        'errorMessage': message,
                        'agentVersion': shared_utils.APP_VERSION,
                    },
                    headers={'Authorization': f'Bearer {token}'},
                    timeout=10,
                )
                try:
                    os.makedirs(os.path.dirname(flag_path), exist_ok=True)
                    with open(flag_path, 'w') as f:
                        f.write(','.join(reasons))
                except Exception as e:
                    logging.debug(f"Could not write reboot-pending flag: {e}")
                logging.info(f"[REBOOT-PENDING] Alert sent: {message}")
            except Exception as e:
                logging.debug(f"[REBOOT-PENDING] Alert send failed (non-critical): {e}")

        t = threading.Thread(target=_emit_alert, daemon=True)
        t.start()

    def _flush_pending_watchdog_events(self):
        """Submit any watchdog-restart history entries that haven't reached
        Firestore yet. Idempotent — safe to call every iteration while
        Firebase is connected; already-submitted entries are skipped.
        """
        if not self.firebase_client or not self.firebase_client.is_connected():
            return
        try:
            pending = watchdog_state.read_pending_history()
        except Exception as e:
            logging.debug(f"Watchdog pending-history read failed (non-fatal): {e}")
            return
        for entry in pending:
            restart_id = entry.get('restart_id')
            if not restart_id:
                continue  # malformed entry; skip rather than risk duplicate Firestore rows
            event_kind = entry.get('event_kind', 'watchdog_restart')
            # Top-level queryable fields; full snapshot stays nested in `diagnostics`
            extra = {
                'reason_code': entry.get('reason_code'),
                'seconds_since_success': entry.get('seconds_since_last_success'),
                'consecutive_failures': entry.get('consecutive_failures'),
                'last_error': entry.get('last_error'),
                'restart_id': restart_id,
                'diagnostics': entry,
            }
            extra = {k: v for k, v in extra.items() if v is not None}
            try:
                log_id = self.firebase_client.log_event(
                    action=event_kind,
                    level='warning',
                    details=(
                        f"{event_kind}: {entry.get('reason_code', 'unknown')} "
                        f"({entry.get('seconds_since_last_success', '?')}s since last success)"
                    ),
                    extra_fields=extra,
                    doc_id=restart_id,  # idempotent dedup key
                )
                if log_id:
                    watchdog_state.mark_submitted(restart_id, log_id)
                    logging.info(f"Watchdog restart event submitted: {event_kind} ({restart_id})")
            except Exception as e:
                logging.warning(f"Failed to submit watchdog restart event {restart_id}: {e}")

    def _handle_watchdog_restart(self, exit_code: int, snapshot: dict):
        """Self-restart watchdog callback.

        Called from ConnectionManager._watchdog_loop when a stuck-connection
        restart is authorized. Arms a hard-exit timer first (so nothing below
        can wedge the exit), logs a visible banner, sets the session intent
        so the startup classifier treats the next boot as planned, then
        signals the main loop to exit cleanly with the provided code (43).
        """
        # 1. Arm hard-exit FIRST. If anything below wedges (e.g. set_intent
        #    blocks on a corrupt state file, main loop takes >30s to unwind),
        #    the timer guarantees the process dies so the host restarts us.
        def _hard_exit():
            try:
                # No offline flush — the host restarts us at once and online:false
                # would just flap the dashboard. Bounded join so a wedged client
                # can't defeat the hard exit.
                try:
                    if self.firebase_client:
                        stopper = threading.Thread(
                            target=self.firebase_client.stop,
                            kwargs={'intentional': True},
                            name='watchdog-firebase-stop',
                            daemon=True,
                        )
                        stopper.start()
                        stopper.join(timeout=5.0)
                except Exception as e:
                    logging.debug(f"[WATCHDOG] Firebase client stop failed: {e}")
                logging.error(f"[WATCHDOG] Hard-exit timer firing with code {exit_code}")
            finally:
                os._exit(exit_code)

        try:
            threading.Timer(30.0, _hard_exit).start()
        except Exception as e:
            logging.error(f"[WATCHDOG] Failed to arm hard-exit timer: {e}")

        # 2. Log the banner (primary debug surface)
        try:
            shared_utils.log_watchdog_restart_block(snapshot)
        except Exception as e:
            logging.error(f"[WATCHDOG] banner log failed: {e}")

        # 3. Set session intent so startup classifier doesn't treat the next
        #    boot as unexpected_service_restart
        try:
            session_state.set_intent("watchdog_restart")
        except Exception as e:
            logging.debug(f"[WATCHDOG] set_intent failed: {e}")

        # 4. Signal main loop to exit cleanly via existing exit-code mechanism
        self._restart_exit_code = exit_code
        self.is_alive = False

    def recover_running_processes(self):
        """
        On service restart, re-adopt processes from the previous session -- on
        proof only. A row is re-adopted iff the identity recorded at launch
        (create_time on the pid row) still matches the live process at that
        pid (identity_matches). Anything less is a guess, and D3 says a guess
        launches fresh: rows without an identity record (pre-3.3.0 state
        files) are skipped and the entry relaunches via the normal loop; rows
        whose pid was recycled are removed so the stale record can never feed
        a later kill. Also cleans up dead PIDs to prevent unbounded growth.
        """
        try:
            app_states = shared_utils.read_json_from_file(shared_utils.RESULT_FILE_PATH)

            if not app_states:
                logging.info("No previous app states found (file empty or doesn't exist)")
                return

            logging.debug(f"Found {len(app_states)} PID(s) in app_states.json")

            config = shared_utils.read_config()
            if not config:
                logging.warning("Could not load config for process recovery")
                return

            processes = config.get('processes', [])
            configured_ids = {p.get('id') for p in processes if p.get('id')}
            logging.debug(f"Checking {len(processes)} configured process(es) for recovery")

            # Rows that survive the sweep; anything not copied over is dropped
            # from the state file (invalid key, dead pid, recycled pid).
            cleaned_states = {}
            dropped_count = 0
            recovered_count = 0

            for pid_str, state_info in app_states.items():
                try:
                    # Invalid PID entries (e.g. "None" from failed launches).
                    if pid_str in ('None', 'null', ''):
                        dropped_count += 1
                        logging.debug(f"Removing invalid PID entry: '{pid_str}'")
                        continue
                    try:
                        pid = int(pid_str)
                    except (TypeError, ValueError):
                        # Unrecognised non-numeric key: it cannot be adopted,
                        # but deleting data this code does not understand is
                        # not recovery's job -- keep it and move on.
                        cleaned_states[pid_str] = state_info
                        logging.debug(f"Skipping non-numeric PID key '{pid_str}' in state file")
                        continue

                    if not Util.is_pid_running(pid):
                        # WHY a dead LAUNCH_FAILED row survives the restart
                        # sweep: same rule as cleanup_stale_tracking_data --
                        # it is the D5 surfacing row for an entry that cannot
                        # launch. Dropping it here would restart the service
                        # into the hollow INACTIVE ring with no row left for
                        # _surface_launch_failed to reuse. The periodic sweep
                        # clears it once the entry has a live row again.
                        if (isinstance(state_info, dict)
                                and state_info.get('status') == 'LAUNCH_FAILED'
                                and state_info.get('id') in configured_ids):
                            cleaned_states[pid_str] = state_info
                            continue
                        dropped_count += 1
                        logging.debug(f"PID {pid_str} is no longer running (will be removed from state file)")
                        continue

                    # The identity gate (D1). The record was written when the
                    # pid was bound; the row carries the create_time/exe half,
                    # the row's key supplies the pid half.
                    has_record = isinstance(state_info, dict) and 'create_time' in state_info
                    if has_record:
                        record = {
                            'pid': pid,
                            'create_time': state_info.get('create_time'),
                            'exe': state_info.get('exe'),
                        }
                        if not shared_utils.identity_matches(record, pid):
                            # A different process wears this pid now. Drop the
                            # row so the stale record can never resolve into a
                            # kill; the entry relaunches via the normal loop.
                            dropped_count += 1
                            logging.warning(
                                f"PID {pid} refused: pid recycled (recorded create_time "
                                f"{state_info.get('create_time')} does not match the live "
                                f"process) - removing stale row, entry will relaunch")
                            continue

                    # Row survives: the pid is live and any record it carries
                    # is proven against the live process.
                    cleaned_states[pid_str] = state_info

                    process_id = state_info.get('id') if isinstance(state_info, dict) else None
                    if not process_id:
                        logging.warning(f"PID {pid} has no process ID in state file")
                        continue

                    process = next((p for p in processes if p.get('id') == process_id), None)
                    if not process:
                        logging.warning(f"PID {pid} is running but process ID {process_id} not found in config")
                        continue

                    if not has_record:
                        # Pre-3.3.0 state file: the pid is alive but nothing
                        # proves it is the process owlette launched. D3: never
                        # adopt on doubt -- the normal loop launches fresh, and
                        # from then on the entry carries a durable record.
                        logging.info(
                            f"PID {pid} ('{process.get('name')}') has "
                            f"no identity record (pre-3.3.0) - will relaunch "
                            f"instead of adopting")
                        continue

                    mode = process.get('launch_mode', 'always' if process.get('autolaunch', False) else 'off')
                    if mode == 'always' or (mode == 'scheduled' and shared_utils.is_within_schedule(process.get('schedules'), self._cached_site_timezone)):
                        self.last_started[process_id] = {
                            'time': datetime.datetime.now(),
                            'pid': pid
                        }
                        recovered_count += 1
                        logging.info(f"[OK] Process '{process.get('name')}' (PID {pid}) re-adopted by identity")
                    else:
                        logging.info(f"Skipping recovery of '{process.get('name')}' (PID {pid}) - launch_mode is '{mode}'")
                except Exception as e:
                    logging.error(f"Error checking PID {pid_str}: {e}")
                    # On error, keep the PID to be safe
                    cleaned_states[pid_str] = state_info

            if dropped_count > 0:
                shared_utils.write_json_to_file(cleaned_states, shared_utils.RESULT_FILE_PATH)
                logging.info(f"[OK] Cleaned up {dropped_count} dead or stale PID(s) from state file")

            if recovered_count > 0:
                logging.info(f"[OK] Successfully recovered {recovered_count} running process(es) from previous session")
            else:
                logging.debug("No running processes to recover from previous session")

        except Exception as e:
            logging.error(f"Error recovering processes from previous session: {e}")
            logging.exception("Full traceback:")

    def log_and_notify(self, process, reason):
        process_name = Util.get_process_name(process)

        logging.error(reason)

    
    # The service deliberately no longer kills the tray on the way out: the
    # desktop app owns its lifetime and its footer is where an operator restarts
    # a stopped service. Killing it left machines with no way back (2026-08-13
    # leave-site flow).

    def _is_tray_alive(self):
        """Check whether the desktop app (which supplies the tray icon) is running.

        The tracked PID is only the fast path, and it is validated against the
        image name because the desktop app is a single instance: when the app is
        already up, our CreateProcessAsUser launch is folded into it and the
        process we recorded exits within a second. Without the pid file below
        that would look like "tray died" every cycle and relaunch forever.
        """
        if self.tray_icon_pid:
            try:
                proc = psutil.Process(self.tray_icon_pid)
                if (proc.is_running()
                        and proc.status() != psutil.STATUS_ZOMBIE
                        and (proc.name() or '').lower() == osadapter.desktop_process_name()):
                    return True
            except (psutil.NoSuchProcess, psutil.AccessDenied):
                pass
            # PID is stale — clear it
            self.tray_icon_pid = None

        # Authoritative: written for the app's whole lifetime, so it also covers
        # a {userstartup} launch and survives a service restart.
        pid = shared_utils.read_desktop_pid(shared_utils.TRAY_PID_PATH)
        if pid:
            self.tray_icon_pid = pid
            return True

        return False

    def _try_launch_tray(self):
        """Launch the desktop app in tray mode, with cooldown to avoid thrashing.
        Returns True if launched (or already running), False if skipped/failed."""
        if self._is_tray_alive():
            return True

        # Stamped before the attempt, so a failed launch (missing exe, no
        # interactive session) is paced like a crash loop.
        now = time.time()
        elapsed = now - self._tray_last_launch_time
        if elapsed < self._tray_launch_cooldown:
            return False
        self._tray_last_launch_time = now

        if self.launch_desktop_app_as_user(shared_utils.DESKTOP_TRAY_ARG):
            logging.info("Tray icon launched")
            return True
        else:
            # launch_desktop_app_as_user already logged why (missing exe or no
            # interactive session).
            logging.debug("Could not launch tray icon")
            return False

    def _is_restart_prompt_active(self):
        """True while a reboot countdown prompt is believed to be on screen.

        The prompt is a window inside the single-instance desktop app now, not a
        separate process, so there is nothing for the service to scan for; it
        tracks its own launch instead (see RESTART_PROMPT_ACTIVE_SECONDS). The
        gate is conservative in the right direction — expiring early would
        re-prompt an operator who is already looking at the countdown.
        """
        return time.monotonic() < self._restart_prompt_until

    # ─── Cortex Process Management ──────────────────────────────────────

    def _is_cortex_alive(self):
        """Check if the Cortex process is still running using tracked PID."""
        if self.cortex_pid:
            try:
                proc = psutil.Process(self.cortex_pid)
                if proc.is_running() and proc.status() != psutil.STATUS_ZOMBIE:
                    return True
            except (psutil.NoSuchProcess, psutil.AccessDenied):
                pass
            self.cortex_pid = None

        # Fallback: check PID file written by Cortex itself
        pid_path = shared_utils.CORTEX_PID_PATH
        if os.path.exists(pid_path):
            try:
                with open(pid_path, 'r') as f:
                    pid = int(f.read().strip())
                proc = psutil.Process(pid)
                if proc.is_running() and proc.status() != psutil.STATUS_ZOMBIE:
                    self.cortex_pid = pid
                    return True
            except (ValueError, psutil.NoSuchProcess, psutil.AccessDenied, OSError):
                pass

        return False

    def _try_launch_cortex(self):
        """Launch the Cortex process with cooldown. Mirrors _try_launch_tray() pattern.
        Returns True if launched (or already running), False if skipped/failed."""
        if not shared_utils.is_cortex_enabled():
            return False

        if self._is_cortex_alive():
            return True

        now = time.time()
        elapsed = now - self._cortex_last_launch_time
        if elapsed < self._cortex_launch_cooldown:
            return False

        if self.launch_python_script_as_user('owlette_cortex.py'):
            self._cortex_last_launch_time = now
            logging.info("Cortex process launched")
            return True
        else:
            logging.debug("Could not launch Cortex (no user session?)")
            return False

    def _process_cortex_ipc_commands(self):
        """Hand any pending Cortex IPC commands to the drain worker.

        Runs on the 5s tick, so it must execute nothing itself. A single
        capture_screenshot costs ~55s end to end (user-session poll plus the
        upload POST), and running that inline stalled process monitoring,
        heartbeats and every other loop duty for the whole window — the
        blocking-the-main-loop landmine, in the one place that most reliably
        hits it.

        Single-flight, mirroring _roost_scrub_thread: one worker at a time
        preserves the serial execution order Cortex expects, since it issues one
        tool call and blocks on its result.

        Gated on the hoot kill switch, not just on hoot being up: the queue
        is group-writable so the console user's hoot process can reach it,
        and with hoot off nothing legitimate writes there — draining it
        anyway would run whatever was dropped in. A kill switch and not a
        privilege boundary: config.json is group-writable as well, so this
        stops a stranger and an idle machine, not the group member who can
        switch hoot back on.
        """
        if not shared_utils.is_cortex_enabled():
            return

        if self._cortex_ipc_thread is not None and self._cortex_ipc_thread.is_alive():
            return

        cmd_dir = shared_utils.CORTEX_IPC_CMD_DIR
        if not os.path.isdir(cmd_dir):
            return
        try:
            # `.json` only — the writer stages `{cmd_id}.json.tmp` first, and
            # picking that up would read a half-written command.
            if not any(f.endswith('.json') for f in os.listdir(cmd_dir)):
                return
        except OSError:
            return

        t = threading.Thread(
            target=self._drain_cortex_ipc_commands, daemon=True, name='cortex-ipc'
        )
        t.start()
        self._cortex_ipc_thread = t

    def _drain_cortex_ipc_commands(self):
        """Execute pending Cortex IPC commands. Runs on a worker, never the loop.

        Scans ipc/cortex_commands/ for JSON files, executes the tool,
        writes result to ipc/cortex_results/.
        """
        cmd_dir = shared_utils.CORTEX_IPC_CMD_DIR
        result_dir = shared_utils.CORTEX_IPC_RESULT_DIR

        if not os.path.isdir(cmd_dir):
            return

        try:
            files = [f for f in os.listdir(cmd_dir) if f.endswith('.json')]
        except OSError:
            return

        for filename in files:
            cmd_path = os.path.join(cmd_dir, filename)
            try:
                with open(cmd_path, 'r', encoding='utf-8') as f:
                    cmd = json.load(f)

                cmd_id = cmd.get('id', filename.replace('.json', ''))
                tool_name = cmd.get('tool_name', '')
                tool_params = cmd.get('tool_params', {})

                logging.debug(f"Processing Cortex IPC command: {cmd_id} ({tool_name})")

                result = self._execute_cortex_command(tool_name, tool_params)

                os.makedirs(result_dir, exist_ok=True)
                result_path = os.path.join(result_dir, f"{cmd_id}.json")
                tmp_path = result_path + '.tmp'
                with open(tmp_path, 'w', encoding='utf-8') as f:
                    json.dump({'id': cmd_id, 'result': result}, f)
                os.replace(tmp_path, result_path)

                os.remove(cmd_path)
                logging.debug(f"Cortex IPC command completed: {cmd_id}")

            except Exception as e:
                logging.error(f"Error processing Cortex IPC command {filename}: {e}")
                # Remove corrupt command to prevent infinite retry
                try:
                    os.remove(cmd_path)
                except OSError:
                    pass

    def _restart_requested(self, path):
        """Whether a restart flag the daemon should honour is waiting.

        On Windows the desktop app writes it after its own elevated click and
        the tree is ACL'd. Off Windows `tmp/` is group-writable, so a flag the
        console user wrote would restart the agent with none of the privileged
        seam's nonce, rate limit or audit — the app asks through
        `ipc/requests/` there instead, and a flag from any other account is
        removed rather than obeyed.

        Off a link and not through one: `os.stat` on a symlink reports the
        target's owner, so a link to any root-owned file planted under this
        name would read back as the daemon's own flag and restart the agent on
        every tick.
        """
        try:
            info = os.lstat(path)
        except OSError:
            return False
        if sys.platform == 'win32':
            return True
        if stat.S_ISREG(info.st_mode) and info.st_uid == os.geteuid():
            return True
        logging.warning(
            f"Ignoring a restart flag the daemon did not write (uid "
            f"{info.st_uid}): restarting the agent is a privileged request, "
            f"not a file in tmp/")
        try:
            # A directory goes whole: anything in the group can create one
            # under this name, and an entry the daemon cannot remove logs the
            # same refusal every five seconds.
            if stat.S_ISDIR(info.st_mode):
                import shutil

                shutil.rmtree(path)
            else:
                os.remove(path)
        except OSError as e:
            logging.debug(f"Could not remove the foreign restart flag: {e}")
        return False

    def _process_privileged_requests(self):
        """Hand any pending desktop-app requests to a drain worker.

        `configure_site`'s POSIX seam: off Windows the app runs as the console
        user and can neither write the token store nor control the daemon, so
        pairing, an agent restart and a machine reboot are requests the daemon
        executes. Gated exactly like the hoot queue beside it — a platform that
        has no seam, a single-flight worker and one directory listing — because
        a `pair` polls for ten minutes and a `restart` ends this process, and
        neither is the 5s tick's to hold.
        """
        thread = self._privileged_requests_thread
        if thread is not None and thread.is_alive():
            return

        if not configure_site.poll_request_seam():
            return

        t = threading.Thread(
            target=configure_site.drain_privileged_requests,
            daemon=True,
            name='ipc-requests',
        )
        t.start()
        self._privileged_requests_thread = t

    def _execute_cortex_command(self, tool_name, tool_params):
        """Execute a Cortex IPC tool command using existing service logic.

        Maps Tier 2 tool names to the service's existing command handlers.
        """
        process_name = tool_params.get('process_name', '')

        if tool_name == 'restart_process':
            return self._handle_cortex_process_command('restart_process', process_name)
        elif tool_name == 'kill_process':
            return self._handle_cortex_process_command('kill_process', process_name)
        elif tool_name == 'start_process':
            return self._handle_cortex_process_command('restart_process', process_name)
        elif tool_name == 'set_launch_mode':
            mode = tool_params.get('mode', 'off')
            schedules = tool_params.get('schedules')
            return self._handle_cortex_set_launch_mode(process_name, mode, schedules)
        elif tool_name == 'capture_screenshot':
            # The on-machine agent renders the bytes as an MCP image block, and
            # an IPC result is a local file rather than a Firestore document.
            return self._handle_capture_screenshot({
                'monitor': tool_params.get('monitor', 0),
                'include_image': True,
            })
        else:
            return {'error': f'Unknown Cortex IPC tool: {tool_name}'}

    def _handle_cortex_process_command(self, command_type, process_name):
        """Handle a process restart/kill/start command from Cortex IPC.

        Mirrors the dashboard command path (_execute_command): resolve the
        running PID from self.last_started and operate on that integer PID via
        the same kill/relaunch helpers. graceful_terminate() expects a PID, not
        the process config dict — passing the dict raised TypeError on every
        call, which the broad except swallowed into a silent 'failed' (so Cortex
        Tier-2 self-healing never actually restarted/killed anything).
        """
        config = shared_utils.read_config()
        processes = config.get('processes', [])

        target = None
        for proc in processes:
            if proc.get('name', '').lower() == process_name.lower():
                target = proc
                break

        if not target:
            return {'error': f'Process not found: {process_name}'}

        process_list_id = target['id']
        last_info = self.last_started.get(process_list_id, {})
        last_pid = last_info.get('pid')

        try:
            if command_type == 'kill_process':
                # The identity gate (D1) lives inside the resolver: tracked
                # pids are proven against their recorded row, the durable
                # record substitutes for tracking after a restart, and a
                # strict-discovery hit is only killable on identity read at
                # this moment. A refusal names the entry, the pid and why.
                target_pid, note, refusal = _resolve_kill_target(self, target)
                if refusal:
                    return {'error': refusal}
                if target_pid:
                    shared_utils.graceful_terminate(
                        target_pid, exe_path=target.get('exe_path'))
                    shared_utils.update_process_status_in_json(
                        target_pid, 'KILLED', self.firebase_client, process_id=process_list_id)
                    # Mark as killed (not deleted) so the main loop doesn't treat
                    # an empty last_started as "untracked -> needs launch".
                    self.last_started[process_list_id] = {
                        'killed': True, 'time': datetime.datetime.now()}
                    return {'status': 'completed',
                            'result': f'Process {process_name} terminated (PID {target_pid}){note}'}
                return {'status': 'completed',
                        'result': f'Process {process_name} was not running'}
            else:
                # restart_process (also used for start): relaunch if running, else launch.
                note = ''
                if not (last_pid and Util.is_pid_running(last_pid)):
                    # As in kill_process: an untracked-but-live instance would be
                    # duplicated. This runs unattended from hoot self-healing, so
                    # nobody would catch the second copy. The durable record is
                    # consulted first; a discovery hit is INHERITED (recorded at
                    # bind time, _adopt_running_instance) rather than merely
                    # read, because the pid must survive the kill-and-relaunch
                    # gate a moment later -- restart, unlike kill, gives the
                    # process a future.
                    recorded_pid = _resolve_recorded_pid(process_list_id)
                    if recorded_pid:
                        # Re-track what the record proves is ours so the
                        # relaunch helper sees consistent state.
                        self.last_started[process_list_id] = {
                            'time': datetime.datetime.now(), 'pid': recorded_pid}
                        last_pid = recorded_pid
                        note = ' (PID resolved from durable identity record)'
                    elif target.get('exe_path'):
                        adopted_pid = self._adopt_running_instance(target)
                        if adopted_pid:
                            last_pid = adopted_pid
                            note = ' (PID discovered by exe/file_path lookup)'
                if last_pid and Util.is_pid_running(last_pid):
                    # Same gate as the dashboard restart: refuse HERE so the
                    # caller gets the reason instead of a silent no-op from
                    # the relaunch helper's own gate.
                    allowed, why = _identity_gate(last_pid, process_list_id)
                    if not allowed:
                        if self.last_started.get(process_list_id, {}).get('pid') == last_pid:
                            self.last_started.pop(process_list_id, None)
                        # D5: surface the refusal on the row involved.
                        _surface_launch_failed(process_list_id, pid=last_pid)
                        return {'error': (f"refusing to restart '{process_name}' "
                                          f"(PID {last_pid}): {why}")}
                    new_pid = self.kill_and_relaunch_process(last_pid, target)
                    return {'status': 'completed',
                            'result': f'Process {process_name} restarted (new PID {new_pid}){note}'}
                new_pid = self.handle_process_launch(target)
                return {'status': 'completed',
                        'result': f'Process {process_name} started (PID {new_pid})'}
        except Exception as e:
            logging.exception(
                f"Cortex process command '{command_type}' failed for '{process_name}'")
            return {'status': 'failed', 'error': str(e)}

    def _handle_cortex_set_launch_mode(self, process_name, mode, schedules=None):
        """Handle a set_launch_mode command from Cortex IPC."""
        config = shared_utils.read_config()
        processes = config.get('processes', [])

        for proc in processes:
            if proc.get('name', '').lower() == process_name.lower():
                proc['launch_mode'] = mode
                if mode == 'scheduled' and schedules:
                    proc['schedules'] = schedules
                shared_utils.save_config(config)
                return {'status': 'completed', 'result': f'Launch mode set to {mode} for {process_name}'}

        return {'error': f'Process not found: {process_name}'}

    def _write_cortex_event(self, process_name, error_message, event_type):
        """Write an IPC event file for Cortex autonomous investigation.

        Args:
            process_name: Name of the affected process.
            error_message: Description of what happened.
            event_type: 'process_crash' or 'process_start_failed'.
        """
        if not shared_utils.is_cortex_enabled():
            return

        events_dir = shared_utils.CORTEX_IPC_EVENTS_DIR
        os.makedirs(events_dir, exist_ok=True)

        event_id = f"evt_{int(time.time()*1000)}_{process_name}"
        event_path = os.path.join(events_dir, f"{event_id}.json")

        event = {
            'id': event_id,
            'processName': process_name,
            'errorMessage': error_message,
            'eventType': event_type,
            'machineId': shared_utils.get_machine_id(),
            'machineName': socket.gethostname(),
            'timestamp': time.time(),
        }

        try:
            tmp_path = event_path + '.tmp'
            with open(tmp_path, 'w', encoding='utf-8') as f:
                json.dump(event, f)
            os.replace(tmp_path, event_path)
            logging.info(f"Cortex event written: {event_id} ({event_type}: {process_name})")
        except Exception as e:
            logging.error(f"Failed to write Cortex event: {e}")

    # ─── End Cortex ───────────────────────────────────────────────────────

    def _find_running_process_by_exe(self, exe_path, file_path=None, strict=False):
        """Find a running process by its executable path.

        Delegates to shared_utils.find_running_process_by_exe (shared with the
        GUI's kill/restart flow) — see its docstring for the matching rules:
        startup-adoption basename matching, strict kill semantics (unique-match
        requirement without file_path corroboration), and .bat/.cmd
        cmd.exe-wrapper handling.
        """
        return shared_utils.find_running_process_by_exe(exe_path, file_path, strict=strict)

    def _launch_lock_for(self, process_list_id):
        """The launch lock for one process entry, created on first use."""
        with self._launch_locks_guard:
            lock = self._launch_locks.get(process_list_id)
            if lock is None:
                lock = threading.RLock()
                self._launch_locks[process_list_id] = lock
            return lock

    def _adopt_running_instance(self, process):
        """Adopt a live instance of `process` that the service isn't tracking.

        Returns its PID (and records it in last_started) or None.

        Used by the operator-initiated start paths, where last_started is not
        proof of absence: recover_running_processes never adopts an off-mode
        process, so a perfectly healthy instance can be live and untracked, and
        launching on top of it is what produces duplicates.

        strict=True is load-bearing, not caution. Several instances of one
        executable are the norm for the apps Owlette supervises — every
        TouchDesigner project is the same TouchDesigner.exe with a different
        .toe — so a bare image-name match is never enough to call one of them
        "this process". Strict requires either an exact exe-path match that is
        unique on the box, or a basename match corroborated by file_path
        appearing in the command line. With several candidates and nothing to
        disambiguate it returns None, and we launch rather than adopt a
        stranger — the same trade kill_process makes.
        """
        exe_path = process.get('exe_path', '')
        if not exe_path:
            return None
        pid = self._find_running_process_by_exe(
            exe_path, process.get('file_path', ''), strict=True)
        if not pid:
            return None
        # INHERIT (D1): the identity is captured at the moment of binding, so
        # the adopted process is indistinguishable from a launched one on
        # every later path. Unreadable identity declines the bind (see
        # _inherit_identity_extra) and the caller launches fresh.
        inherit_extra = _inherit_identity_extra(pid)
        if inherit_extra is None:
            return None
        process_list_id = process['id']
        self.last_started[process_list_id] = {
            'time': datetime.datetime.now(), 'pid': pid}
        shared_utils.update_process_status_in_json(
            pid, 'RUNNING', self.firebase_client, process_id=process_list_id,
            extra=inherit_extra)
        logging.info(
            f"[OK] Adopted already-running '{Util.get_process_name(process)}' "
            f"(PID {pid}) instead of launching a duplicate")
        return pid

    def _enable_privileges(self):
        """Enable critical privileges in the service process token.

        LocalSystem has SE_TCB_PRIVILEGE assigned but it may not be enabled
        in the inherited token (e.g. when the service host spawns this process).
        WTSQueryUserToken requires it to be enabled. We also enable
        SeAssignPrimaryTokenPrivilege and SeIncreaseQuotaPrivilege which
        CreateProcessAsUser needs.
        """
        privileges_to_enable = [
            'SeTcbPrivilege',               # Required by WTSQueryUserToken
            'SeAssignPrimaryTokenPrivilege', # Required by CreateProcessAsUser
            'SeIncreaseQuotaPrivilege',      # Required by CreateProcessAsUser
        ]

        try:
            import ctypes
            import win32process
            import win32security

            process_token = win32security.OpenProcessToken(
                win32process.GetCurrentProcess(),
                win32security.TOKEN_ADJUST_PRIVILEGES | win32security.TOKEN_QUERY
            )

            enabled = []
            failed = []
            for priv_name in privileges_to_enable:
                try:
                    luid = win32security.LookupPrivilegeValue('', priv_name)
                    win32security.AdjustTokenPrivileges(
                        process_token, False,
                        [(luid, win32security.SE_PRIVILEGE_ENABLED)]
                    )
                    # AdjustTokenPrivileges returns success even if privilege not held —
                    # must check GetLastError for ERROR_NOT_ALL_ASSIGNED (1300)
                    if ctypes.windll.kernel32.GetLastError() == 1300:
                        failed.append(priv_name)
                    else:
                        enabled.append(priv_name)
                except Exception as e:
                    failed.append(f"{priv_name} ({e})")

            process_token.Close()

            if enabled:
                logging.info(f"Privileges enabled: {', '.join(enabled)}")
            if failed:
                logging.warning(f"Privileges NOT available (will use fallback): {', '.join(failed)}")

        except Exception as e:
            logging.warning(f"Could not adjust process privileges: {e}")

    def _get_token_from_user_process(self, session_id):
        """Obtain a user token by duplicating from a process in the target session.

        Fallback for when WTSQueryUserToken fails (error 1314). Opens an
        existing user-session process (explorer.exe preferred), duplicates
        its token as a primary token, and returns it with the environment block.

        This does NOT require SE_TCB_PRIVILEGE — LocalSystem can open any
        process token via PROCESS_QUERY_INFORMATION.

        Returns:
            (token, environment) on success, (None, None) on failure.
        """
        import ctypes
        import win32profile
        import win32security

        PROCESS_QUERY_INFORMATION = 0x0400

        # Candidates in order of preference — explorer.exe has the richest
        # desktop context; dwm.exe runs even on locked/minimal sessions.
        candidates = ['explorer.exe', 'sihost.exe', 'taskhostw.exe', 'dwm.exe']

        for candidate_name in candidates:
            for proc in psutil.process_iter(['pid', 'name']):
                try:
                    if not proc.info['name'] or proc.info['name'].lower() != candidate_name:
                        continue

                    pid = proc.info['pid']

                    proc_session_id = ctypes.c_ulong(0)
                    if not ctypes.windll.kernel32.ProcessIdToSessionId(
                        pid, ctypes.byref(proc_session_id)
                    ):
                        continue
                    if proc_session_id.value != session_id:
                        continue

                    proc_handle = ctypes.windll.kernel32.OpenProcess(
                        PROCESS_QUERY_INFORMATION, False, pid
                    )
                    if not proc_handle:
                        continue

                    try:
                        token = win32security.OpenProcessToken(
                            proc_handle,
                            win32security.TOKEN_DUPLICATE | win32security.TOKEN_QUERY
                        )

                        # Duplicate as primary token for CreateProcessAsUser
                        dup_token = win32security.DuplicateTokenEx(
                            token,
                            win32security.TOKEN_ALL_ACCESS,
                            None,  # SECURITY_ATTRIBUTES
                            win32security.SecurityImpersonation,
                            win32security.TokenPrimary
                        )
                        token.Close()

                        environment = win32profile.CreateEnvironmentBlock(dup_token, False)

                        logging.info(
                            f"Obtained user token from {candidate_name} "
                            f"(PID {pid}, session {session_id})"
                        )
                        return dup_token, environment

                    finally:
                        ctypes.windll.kernel32.CloseHandle(proc_handle)

                except (psutil.NoSuchProcess, psutil.AccessDenied):
                    continue
                except Exception as e:
                    logging.debug(
                        f"Failed to get token from {candidate_name} "
                        f"PID {proc.info.get('pid', '?')}: {e}"
                    )
                    continue

        logging.warning(f"Could not obtain token from any user process in session {session_id}")
        return None, None

    def _refresh_user_token(self):
        """Re-obtain the console user token, session ID, and environment block.

        Uses a three-tier approach:
        1. WTSQueryUserToken (standard API, requires SE_TCB_PRIVILEGE)
        2. Token cloning from explorer.exe (fallback, no SE_TCB needed)
        3. Cached token from previous successful call (last resort)
        """
        import win32profile
        import win32ts

        try:
            session_id = win32ts.WTSGetActiveConsoleSessionId()
            if session_id == 0xFFFFFFFF:
                logging.warning("No active console session (headless/locked machine)")
                self.console_user_token = None
                self.environment = None
                return False

            # Tier 1: WTSQueryUserToken (standard path)
            token = None
            environment = None
            try:
                token = win32ts.WTSQueryUserToken(session_id)
                environment = win32profile.CreateEnvironmentBlock(token, False)
            except Exception as e:
                error_code = getattr(e, 'winerror', 0)
                if error_code == 1314:
                    logging.debug("WTSQueryUserToken failed (error 1314) — trying token cloning")
                else:
                    logging.debug(f"WTSQueryUserToken failed: {e} — trying token cloning")
                token = None
                environment = None

            # Tier 2: Clone token from explorer.exe (fallback)
            if token is None:
                token, environment = self._get_token_from_user_process(session_id)

            # Tier 3: Use cached token (last resort)
            if token is None:
                if self.console_user_token:
                    logging.debug("Falling back to cached user token")
                    return True
                self.console_user_token = None
                self.environment = None
                return False

            # Success — update cached token
            if self.console_user_token and self.console_user_token != token:
                try:
                    self.console_user_token.Close()
                except Exception as e:
                    logging.debug(f"Could not close old user token: {e}")

            self.console_user_token = token
            self.environment = environment

            if session_id != getattr(self, '_last_logged_session_id', None):
                logging.info(f"User token refreshed for console session {session_id}")
                self._last_logged_session_id = session_id

            return True

        except Exception as e:
            logging.warning(f"Could not obtain console user token: {e}")
            if self.console_user_token:
                logging.debug("Falling back to cached user token")
                return True
            self.console_user_token = None
            self.environment = None
            return False

    def _get_elevated_install_token(self):
        """Get an elevated token that runs on the user's desktop.

        Duplicates the service's own SYSTEM token and sets its session ID
        to the active console session.  This gives the installer full admin
        privileges while running on the user's desktop (not Session 0),
        so sub-installers that need a desktop won't hang.

        Returns:
            (token, environment) or (None, None) if no console session.
        """
        try:
            import ctypes
            import win32api
            import win32profile
            import win32security
            import win32ts

            session_id = win32ts.WTSGetActiveConsoleSessionId()
            if session_id == 0xFFFFFFFF:
                logging.warning("No active console session for elevated install")
                return None, None

            proc_handle = win32api.GetCurrentProcess()
            service_token = win32security.OpenProcessToken(
                proc_handle,
                win32security.TOKEN_DUPLICATE | win32security.TOKEN_QUERY
            )

            elevated_token = win32security.DuplicateTokenEx(
                ExistingToken=service_token,
                DesiredAccess=win32security.TOKEN_ALL_ACCESS,
                ImpersonationLevel=win32security.SecurityImpersonation,
                TokenType=win32security.TokenPrimary,
                TokenAttributes=None,
            )
            service_token.Close()

            # Set the session ID so the process runs on the user's desktop
            ctypes.windll.advapi32.SetTokenInformation(
                int(elevated_token),
                12,  # TokenSessionId
                ctypes.byref(ctypes.c_ulong(session_id)),
                ctypes.sizeof(ctypes.c_ulong),
            )

            environment = win32profile.CreateEnvironmentBlock(elevated_token, False)

            logging.info(f"Created elevated install token for session {session_id}")
            return elevated_token, environment

        except Exception as e:
            logging.error(f"Failed to create elevated install token: {e}")
            return None, None

    def _launch_command_as_user(self, command_line, description):
        """CreateProcessAsUser on the interactive desktop.

        Shared by the python-script launcher and the desktop-app launcher, so
        the token refresh and the STARTUPINFO stay in one place.

        Returns the new PID, or None when there is no interactive session or the
        launch failed.
        """
        try:
            import win32con
            import win32process

            # Refresh token to handle session changes since service startup
            self._refresh_user_token()
            if not self.console_user_token:
                logging.error(f"Cannot launch {description}: no interactive user session")
                return None

            # lpDesktop is required: without it the process inherits the service's
            # hidden desktop and can't create windows or a tray icon.
            si = win32process.STARTUPINFO()
            si.dwFlags = win32process.STARTF_USESHOWWINDOW
            si.wShowWindow = win32con.SW_HIDE
            si.lpDesktop = "WinSta0\\Default"

            _, _, pid, _ = win32process.CreateProcessAsUser(self.console_user_token,
                None,  # Application Name
                command_line,  # Command Line
                None,
                None,
                0,
                win32con.NORMAL_PRIORITY_CLASS,
                self.environment,
                None,
                si)
            return pid
        except Exception as e:
            logging.error(f"Failed to start {description}: {e}")
            return None

    def launch_python_script_as_user(self, script_name, args=None):
        # Get full path to Python interpreter (handles bundled Python installations)
        try:
            python_exe = shared_utils.get_python_exe_path()
        except FileNotFoundError as e:
            logging.error(f"Cannot launch script {script_name}: {e}")
            return False

        script_path = shared_utils.get_path(script_name)
        description = f"script {script_name}"
        if sys.platform != 'win32':
            pid = self._spawn_as_console_user(
                [python_exe, script_path, *shlex.split(args or '')], description)
        else:
            command_line = f'"{python_exe}" "{script_path}" {args}' if args else f'"{python_exe}" "{script_path}"'
            pid = self._launch_command_as_user(command_line, description)
        if pid is None:
            return False

        if 'owlette_cortex.py' in script_name:
            self.cortex_pid = pid
        return True

    def _spawn_as_console_user(self, argv, description):
        """Run `argv` as the user at the machine, off Windows.

        The counterpart of the token ladder: hoot is a kiosk-user process on
        every platform - that is what makes `ipc/cortex_commands` a
        user-to-root channel rather than root talking to itself - and the
        adapter resolves the account and the environment its display lives in.

        Returns the new PID, or None when nobody is signed in or the spawn
        failed.
        """
        import pwd

        user = osadapter.console_user()
        if user is None:
            logging.error(f"Cannot launch {description}: no interactive user session")
            return None
        try:
            return osadapter.spawn_as_user(argv, pwd.getpwnam(user).pw_uid)
        except (KeyError, OSError, ValueError) as e:
            logging.error(f"Failed to start {description}: {e}")
            return None

    def launch_desktop_app_as_user(self, *args):
        """Launch owlette-desktop.exe in the interactive session.

        The desktop app replaces owlette_tray.py and owlette_gui.py: `--tray`
        asks for a tray icon with no window, `--restart-prompt` for the reboot
        countdown. It is a single instance, so a launch while it is already
        running is forwarded to the live process and this one exits — which is
        exactly how a `--restart-prompt` reaches an app that is already in the
        tray.

        Returns True when the launch was issued.
        """
        exe_path = shared_utils.get_desktop_exe_path()
        if not exe_path:
            # Not a crash — mid-upgrade and dev boxes just have no local UI. Warn
            # once, then debug, or a box that never gets the app logs a WARNING
            # every cooldown forever.
            expected = os.path.join(
                os.path.dirname(os.path.dirname(shared_utils.get_path())),
                'app',
                shared_utils.DESKTOP_EXE_NAME,
            )
            message = (
                f"Desktop app not found - expected {expected}. "
                f"No local UI will be available on this machine."
            )
            if self._desktop_exe_missing_logged:
                logging.debug(message)
            else:
                logging.warning(message)
                self._desktop_exe_missing_logged = True
            return False

        # Found it again after an absence — let the next disappearance warn.
        self._desktop_exe_missing_logged = False

        # Detached, not a child: a tree-walking service stop would otherwise take
        # the operator's UI down with it, tray included, leaving no way to start
        # the service again.
        command_line = shared_utils.build_detached_launch_command(exe_path, args)
        description = f"desktop app ({' '.join(args) if args else 'no args'})"
        pid = self._launch_command_as_user(command_line, description)
        if pid is None:
            return False

        # That pid is the handoff cmd.exe, not the app, so it isn't recorded —
        # _is_tray_alive() adopts the real one from tmp/tray.pid.
        logging.info(f"Launched {description} (detached)")
        return True

    def execute_in_user_session(self, job_type, code, timeout=30, trusted=False):
        """Execute code in the interactive user's desktop session.

        Launches session_exec.py via CreateProcessAsUser, which runs
        Python/cmd/PowerShell in the user's session and writes the result
        to an IPC file. Windows only: off it, `ipc/jobs` is the resident
        desktop app's queue and `osadapter.run_job` is how a job is put there,
        so a second writer executing out of band would have the app run the
        same job over again.

        Args:
            job_type: 'python', 'cmd', or 'powershell'
            code: The code or command string to execute
            timeout: Max execution time in seconds (default 30, max 120)

        Returns:
            dict with keys: stdout, stderr, exitCode, error, durationMs, files,
            outputDir. The `outputDir` field is the absolute path of the IPC
            output directory the user-session process wrote to, so callers
            (e.g. screenshot_capture) can read files['screenshot.jpg'] etc.
            without racing on `ipc/results/` directory enumeration.
            On failure returns dict with 'error' key (plus 'outputDir');
            the off-Windows refusal carries the error alone.
        """
        if sys.platform != 'win32':
            return {'error': 'unsupported_on_platform: user-session execution '
                             'is the windows arm of osadapter.run_job'}

        import uuid
        import json as _json

        request_id = str(uuid.uuid4())
        ipc_dir = shared_utils.get_data_path('ipc')
        output_dir = os.path.join(ipc_dir, 'results', request_id)
        job_path = os.path.join(ipc_dir, 'jobs', f'{request_id}.json')
        result_path = os.path.join(output_dir, 'result.json')

        os.makedirs(os.path.join(ipc_dir, 'jobs'), exist_ok=True)
        os.makedirs(output_dir, exist_ok=True)

        job = {
            'type': job_type,
            'code': code,
            'timeout': min(timeout, 120),
            'outputDir': output_dir,
            'trusted': bool(trusted),
        }
        with open(job_path, 'w') as f:
            _json.dump(job, f)

        try:
            success = self.launch_python_script_as_user(
                'session_exec.py', f'"{job_path}"'
            )
            if not success:
                return {
                    'error': 'Failed to launch in user session — no interactive session available',
                    'outputDir': output_dir,
                }

            # Poll for result (timeout + 5s grace period for startup)
            poll_timeout = timeout + 5
            start = time.time()
            while time.time() - start < poll_timeout:
                if os.path.exists(result_path):
                    # Wait briefly for file to be fully written
                    time.sleep(0.2)
                    try:
                        with open(result_path, 'r') as f:
                            result = _json.load(f)
                        # Inject outputDir so callers can read files[] entries
                        # directly without scanning the IPC results directory.
                        result['outputDir'] = output_dir
                        return result
                    except (_json.JSONDecodeError, IOError):
                        time.sleep(0.3)
                        continue
                time.sleep(0.5)

            return {
                'error': f'Execution timed out after {timeout}s',
                'outputDir': output_dir,
            }

        finally:
            try:
                os.remove(job_path)
            except OSError:
                pass

    @staticmethod
    def _validate_path(path, label="Path"):
        """Validate a file/directory path for security.
        Rejects UNC paths (remote shares) and symbolic links to prevent
        path-based attacks from Firestore-sourced configuration.
        """
        if not path:
            return path
        # Reject UNC paths (\\server\share) to prevent remote share attacks
        if path.startswith('\\\\') or path.startswith('//'):
            raise ValueError(f"{label} cannot be a UNC/network path: {path}")
        # Normalize to absolute path to prevent traversal
        resolved = os.path.abspath(path)
        if os.path.islink(resolved):
            raise ValueError(f"{label} cannot be a symbolic link: {path}")
        return resolved

    def launch_process_as_user(self, process):
        # Managed launch stays in the daemon on every OS, but only Windows
        # does it through a token: off Windows the adapter resolves the
        # console user and spawns as them, and the record below is shared.
        if sys.platform != 'win32':
            return self._record_launch(
                process, osadapter.launch_managed_process(process))

        visibility = process.get('visibility', 'Show')

        priority = process.get('priority', 'Normal')

        exe_path = process.get('exe_path', '')
        exe_path = exe_path.replace('/', '\\')
        try:
            exe_path = self._validate_path(exe_path, "Executable path")
            if not os.path.isfile(exe_path):
                raise FileNotFoundError('Executable path not found!')
        except (ValueError, FileNotFoundError) as e:
            logging.error(f'Error: {e}')
            return None

        file_path = process.get('file_path', '')
        if file_path:
            file_path = file_path.replace('/', '\\')
            try:
                file_path = self._validate_path(file_path, "File path")
            except ValueError as e:
                logging.error(f'Error: {e}')
                return None
        # If file path exists, leave as-is (could be file or cmd args)
        file_path = f"{file_path}" if os.path.isfile(file_path) else file_path
        logging.info(f"Starting {exe_path}{' ' if file_path else ''}{file_path}...")

        cwd = process.get('cwd', None)
        if cwd == '':
            cwd = None
        if cwd:
            try:
                cwd = self._validate_path(cwd, "Working directory")
            except ValueError as e:
                logging.error(f'Error: {e}')
                return None
        if cwd and not os.path.isdir(cwd):
            logging.error(f"Working directory {cwd} does not exist.")
            return None

        # Launch the process as the logged-in user via CreateProcessAsUser.
        # Token is refreshed before each launch to handle session changes.

        # Normalize visibility (backward compatible with Show/Hide)
        if visibility == 'Show':
            visibility = 'Normal'
        elif visibility == 'Hide':
            visibility = 'Hidden'

        if cwd:
            logging.info(f"Command will run in directory: {cwd}")

        logging.info(f"Launching: {exe_path}{' ' + file_path if file_path else ''} "
                     f"(visibility={visibility}, priority={priority})")

        pid = None

        # Refresh user token to handle session changes (logout/login, RDP, user switch)
        self._refresh_user_token()

        if not self.console_user_token:
            logging.error("No interactive user session available - cannot launch process")
            return None

        # CreateProcessAsUser puts the helper in the user's session; it then
        # ShellExecuteEx's the target so it gets full desktop/GPU context.
        import json as json_module
        import uuid
        import win32con
        import win32process

        # The uuid suffix is required: os.getpid() is constant for the service's
        # life, so two concurrent launches in the same second shared handoff
        # paths — one helper read the other's args and deleted its file.
        tmp_dir = shared_utils.get_data_path('tmp')
        handoff = f'{int(time.time())}_{os.getpid()}_{uuid.uuid4().hex[:8]}'
        pid_file = os.path.join(tmp_dir, f'pid_{handoff}.txt')
        args_file = os.path.join(tmp_dir, f'launch_{handoff}.json')

        try:
            launch_args = {
                'exe_path': exe_path,
                'file_path': file_path,
                'cwd': cwd,
                'visibility': visibility,
                'priority': priority,
                'pid_file': pid_file
            }
            with open(args_file, 'w') as f:
                json_module.dump(launch_args, f)

            python_exe = shared_utils.get_python_exe_path()
            launcher_script = shared_utils.get_path('process_launcher.py')
            helper_cmd = f'"{python_exe}" "{launcher_script}" "{args_file}"'

            startup_info = win32process.STARTUPINFO()
            startup_info.lpDesktop = "WinSta0\\Default"

            # The helper only makes COM calls, so it needs no console; the target
            # gets GUI context via Task Scheduler + cmd /c start.
            DETACHED_PROCESS = 0x00000008
            _, _, helper_pid, _ = win32process.CreateProcessAsUser(
                self.console_user_token,
                None,
                helper_cmd,
                None, None, 0,
                win32con.NORMAL_PRIORITY_CLASS | DETACHED_PROCESS,
                self.environment,
                None,
                startup_info
            )
            logging.debug(f"Launcher helper started with PID {helper_pid}")

            # ShellExecuteEx returns the PID immediately, so 1-2s is typical;
            # the slack covers file-association launches resolving the real PID.
            for _ in range(50):  # 5 second timeout
                if os.path.exists(pid_file):
                    time.sleep(0.3)
                    break
                time.sleep(0.1)

            if os.path.exists(pid_file):
                with open(pid_file, 'r') as f:
                    pid_content = f.read().strip()

                try:
                    result = json_module.loads(pid_content)
                except (json_module.JSONDecodeError, ValueError):
                    if pid_content.startswith('ERROR:'):
                        logging.error(f"Launcher helper failed: {pid_content}")
                        return None
                    result = {'pid': int(pid_content)}

                if 'error' in result:
                    logging.error(f"Launcher helper failed: {result['error']}")
                    return None

                pid = result['pid']
                if result.get('adopted'):
                    logging.info(f"Adopted existing process with PID {pid} (single-instance app)")
                else:
                    logging.info(f"Process launched with PID {pid}")
            else:
                logging.error("Launcher helper did not produce a PID file within timeout")
                # Fallback: process may have launched but psutil couldn't see it in time.
                # Scan by exe before giving up — prevents spurious failed=True and double-launches.
                # An unambiguous hit here is an INHERIT (D1): the pid did not
                # arrive through the launch handshake, so nothing proves it is
                # our own child -- its identity is captured now, at bind time
                # (ambiguity already refused inside the matching ladder).
                # 'LAUNCHING' mirrors what the happy-path write records, and
                # what the next monitor tick would have written before 3.3.0.
                found_pid = self._find_running_process_by_exe(exe_path, file_path)
                if found_pid:
                    inherit_extra = _inherit_identity_extra(found_pid)
                    if inherit_extra is None:
                        # Died between match and read: binding without a
                        # record is forbidden (D1) -- report launch failure
                        # and let the normal retry path continue.
                        return None
                    shared_utils.update_process_status_in_json(
                        found_pid, 'LAUNCHING', self.firebase_client,
                        process_id=process['id'], extra=inherit_extra)
                    logging.info(f"Fallback scan found process (PID {found_pid}) after PID file timeout")
                    return found_pid
                return None

        except Exception as e:
            logging.error(f"Process launch failed: {e}")
            logging.exception("Full traceback:")
            return None
        finally:
            for f in [args_file, pid_file]:
                try:
                    if os.path.exists(f):
                        os.unlink(f)
                except Exception as e:
                    logging.debug(f"Could not clean up temp file {f}: {e}")

        return self._record_launch(process, pid)

    def _record_launch(self, process, pid):
        """Record a launched managed process in app_states.json; returns its pid.

        Both arms of launch_process_as_user end here: the mechanism that
        starts the process is per-OS, the durable identity record it is
        bound by is not. A launch that produced no pid records nothing.
        """
        if pid is None:
            return None

        self.current_timestamp = int(time.time())

        # Read existing results from the output file
        # read_json_from_file now always returns {} instead of None, so no need for try-except
        self.results = shared_utils.read_json_from_file(shared_utils.RESULT_FILE_PATH)

        if self.results is None:
            logging.warning("read_json_from_file returned None (should not happen), using empty dict")
            self.results = {}

        if str(pid) not in self.results:
            self.results[str(pid)] = {}

        self.results[str(pid)]['timestamp'] = self.current_timestamp

        self.results[str(pid)]['id'] = process['id']

        self.results[str(pid)]['status'] = 'LAUNCHING'

        # Durable identity record (D1/D2): snapshot (create_time, exe) at the
        # moment the PID is bound, so recovery after a service restart and
        # every later destructive path can PROVE this exact process is the one
        # owlette launched instead of trusting a recyclable pid number. For
        # .bat/.cmd entries `pid` is the cmd.exe WRAPPER, so the wrapper's
        # identity is what gets recorded -- consistent with graceful_terminate,
        # which tracks and terminates the wrapper. A single-instance app the
        # helper resolved via ShellExecuteEx handoff is recorded the same way:
        # the snapshot describes whichever process we actually bound.
        identity = shared_utils.read_process_identity(pid)
        if identity is not None:
            self.results[str(pid)]['create_time'] = identity['create_time']
            self.results[str(pid)]['exe'] = identity['exe']
            self.results[str(pid)]['managed'] = True
            self.results[str(pid)]['origin'] = 'launched'
        else:
            # Died between launch and this read: record nothing. The next
            # monitor tick sees the dead pid and runs the normal failure path,
            # and recovery never adopts a recordless row.
            logging.warning(
                f"Process (PID {pid}) exited before its identity could be "
                f"recorded - row left without an identity record")

        try:
            shared_utils.write_json_to_file(self.results, shared_utils.RESULT_FILE_PATH)
        except Exception as e:
            logging.error(f'JSON write error: {e}')

        # Process launched - status will sync via centralized metrics loop
        # (removed direct upload to eliminate duplicates and reduce Firebase writes)
        logging.info(f"[OK] Process launched: PID {pid} -> Will sync on next metrics interval")

        return pid

    def reached_max_relaunch_attempts(self, process):
        process_name = Util.get_process_name(process)
        try:
            attempts = self.relaunch_attempts.get(process_name, 0 if self.first_start else 1)

            process_list_id = shared_utils.fetch_process_id_by_name(process_name, shared_utils.read_config())
            # 0 means "relaunch forever, never escalate to a machine restart".
            # ONLY an absent/unparseable value may fall back to the default:
            # falsiness-defaulting turned explicit 0 into MAX_RELAUNCH_ATTEMPTS
            # and rebooted a kiosk that had opted out.
            raw_attempts = shared_utils.read_config(
                keys=['relaunch_attempts'], process_list_id=process_list_id)
            try:
                relaunches_to_attempt = MAX_RELAUNCH_ATTEMPTS if raw_attempts in (None, '') \
                    else int(raw_attempts)
            except (TypeError, ValueError):
                logging.warning(
                    f"relaunch_attempts for '{process_name}' is not a number "
                    f"({raw_attempts!r}) - falling back to {MAX_RELAUNCH_ATTEMPTS}")
                relaunches_to_attempt = MAX_RELAUNCH_ATTEMPTS
            if relaunches_to_attempt < 0:
                relaunches_to_attempt = MAX_RELAUNCH_ATTEMPTS
            unlimited = relaunches_to_attempt == 0

            if not self._is_restart_prompt_active():
                if unlimited and attempts > 0:
                    self.log_and_notify(
                        process,
                        f'Process relaunch attempt: {attempts} (unlimited)'
                    )
                elif 0 < attempts <= relaunches_to_attempt:
                    self.log_and_notify(
                        process,
                        f'Process relaunch attempt: {attempts} of {relaunches_to_attempt}'
                    )
                # If this is more than the maximum number of attempts allowed.
                # `unlimited` never escalates — that is the whole point of 0.
                if not unlimited and attempts > relaunches_to_attempt:
                    # Write reboot_pending to Firestore so dashboard can approve/dismiss remotely
                    if self.firebase_client and self.firebase_client.is_connected():
                        self.firebase_client.set_reboot_pending(
                            process_name=process_name,
                            reason=f'{process_name} crashed {relaunches_to_attempt} times',
                            timestamp=time.time()
                        )

                    # If a restart prompt isn't already running, open one (local fallback)
                    started_restart_prompt = self.launch_desktop_app_as_user(
                        shared_utils.DESKTOP_RESTART_PROMPT_ARG
                    )
                    if started_restart_prompt:
                        self._restart_prompt_until = time.monotonic() + RESTART_PROMPT_ACTIVE_SECONDS
                        self.log_and_notify(
                            process,
                            f'Terminated {process_name} {relaunches_to_attempt} times. System reboot imminent'
                        )
                        del self.relaunch_attempts[process_name]
                        return True
                    else:
                        logging.info('Failed to open restart prompt.')
            else:
                return True # If it's running, we've already reached the max attempts

            self.relaunch_attempts[process_name] = attempts + 1
            return False

        except Exception as e:
            logging.info(e)

    def kill_and_relaunch_process(self, pid, process):
        # Terminate+launch must be indivisible: the gap between them is exactly
        # when the monitor loop sees no PID and launches its own replacement.
        with self._launch_lock_for(process.get('id', '')):
            return self._kill_and_relaunch_locked(pid, process)

    def _kill_and_relaunch_locked(self, pid, process):
        process_name = Util.get_process_name(process)
        # The identity gate (D1), before anything else -- including the
        # relaunch-attempt counter, because a refused kill is not an attempt.
        # Mismatch or no record: do NOT kill; clear this entry's tracking and
        # let the monitor loop re-establish reality (a fresh launch under D3;
        # a recycled row was already removed by the gate itself).
        allowed, why = _identity_gate(pid, process.get('id', ''))
        if not allowed:
            logging.warning(
                f"Refusing to kill-and-relaunch '{process_name}' (PID {pid}): {why}")
            info = self.last_started.get(process.get('id', ''), {})
            if isinstance(info, dict) and info.get('pid') == pid:
                self.last_started.pop(process.get('id', ''), None)
            # D5: surface the refusal on the row involved (or the entry's
            # newest remaining row when the gate dropped it).
            _surface_launch_failed(process.get('id', ''), pid=pid)
            return None
        if not self.reached_max_relaunch_attempts(process):
            try:
                # Mark as KILLED before terminating so crash detection skips the alert
                shared_utils.update_process_status_in_json(pid, 'KILLED', self.firebase_client, process_id=process.get('id'))

                # Gracefully terminate (WM_CLOSE then hard kill). exe_path
                # lets it reap a cmd.exe wrapper's payload — see its docstring.
                shared_utils.graceful_terminate(pid, exe_path=process.get('exe_path'))

                if self.firebase_client and self.firebase_client.is_connected():
                    self.firebase_client.log_event(
                        action='process_killed',
                        level='warning',
                        process_name=process_name,
                        details=f'Terminated PID {pid} for restart'
                    )

                new_pid = self.launch_process_as_user(process)

                if new_pid is None:
                    logging.error(f"Relaunch of {process_name} failed - no PID returned")
                    return None

                # Must land before the lock releases: a waiting thread re-reads
                # last_started immediately and would otherwise launch a duplicate
                # (callers only record the PID after we return).
                self.last_started[process.get('id', '')] = {
                    'time': datetime.datetime.now(), 'pid': new_pid}

                self.log_and_notify(
                    process,
                    f'Terminated PID {pid} and restarted with new PID {new_pid}'
                )
                shared_utils.update_process_status_in_json(new_pid, 'LAUNCHING', self.firebase_client, process_id=process.get('id'))

                return new_pid

            except Exception as e:
                self.log_and_notify(
                    process,
                    f"Could not kill and restart process {pid}. Error: {e}"
                )
                if self.firebase_client and self.firebase_client.is_connected():
                    self.firebase_client.log_event(
                        action='process_crash',
                        level='error',
                        process_name=process_name,
                        details=f'Failed to kill and restart PID {pid}: {str(e)}'
                    )
                    self.firebase_client.send_process_alert(
                        process_name, f'Failed to kill and restart PID {pid}: {str(e)}', 'process_crash'
                    )
                self._write_cortex_event(process_name, f'Failed to kill and restart PID {pid}: {str(e)}', 'process_crash')
                return None

    @staticmethod
    def _find_sibling_executables(exe_path, max_depth=4, max_results=5):
        """Find likely replacement executables near a missing configured path."""
        exe_name = os.path.basename(exe_path)
        if not exe_name:
            return []

        search_root = os.path.dirname(os.path.abspath(exe_path))
        while search_root and not os.path.isdir(search_root):
            parent = os.path.dirname(search_root)
            if parent == search_root:
                return []
            search_root = parent

        if not search_root or not os.path.isdir(search_root):
            return []

        candidates = []

        def _scan(directory, depth_remaining):
            try:
                with os.scandir(directory) as entries:
                    for entry in entries:
                        try:
                            if entry.is_file(follow_symlinks=False) and entry.name == exe_name:
                                candidates.append((entry.stat(follow_symlinks=False).st_mtime, entry.path))
                            elif depth_remaining > 0 and entry.is_dir(follow_symlinks=False):
                                _scan(entry.path, depth_remaining - 1)
                        except (OSError, PermissionError):
                            continue
            except (OSError, PermissionError):
                return

        _scan(search_root, max_depth)
        candidates.sort(key=lambda item: item[0], reverse=True)
        return [path for _, path in candidates[:max_results]]

    def handle_process_launch(self, process):
        # Callers decided "needs launching" outside the lock; if a launch lands
        # while we wait that decision is stale. _launch_locked re-checks this
        # against the post-lock value.
        pid_before_lock = self.last_started.get(process.get('id', ''), {}).get('pid')
        with self._launch_lock_for(process.get('id', '')):
            return self._launch_locked(process, pid_before_lock)

    def _launch_locked(self, process, pid_before_lock):
        process_id = process.get('id', '')
        current_pid = self.last_started.get(process_id, {}).get('pid')
        if (current_pid and current_pid != pid_before_lock
                and Util.is_pid_running(current_pid)):
            logging.info(
                f"[OK] '{Util.get_process_name(process)}' was launched by another "
                f"thread while this launch waited for the lock (PID {current_pid}) "
                f"- not launching a second instance")
            return current_pid
        exe_path = process.get('exe_path', '').strip()
        if not exe_path:
            process_name = Util.get_process_name(process)
            logging.error(f"Cannot launch '{process_name}': Executable path is not set. Please configure a valid exe_path and set launch mode to Always On or Scheduled.")
            self.last_started[process_id] = {'time': datetime.datetime.now(), 'pid': None, 'failed': True}
            # D5: make the refusal visible - a never-launched entry has no row
            # to reuse and stays INACTIVE (see _surface_launch_failed's WHY).
            _surface_launch_failed(process_id)
            return None

        if not os.path.isfile(exe_path):
            process_name = Util.get_process_name(process)
            logging.error(f"Cannot launch '{process_name}': Executable path does not exist: {exe_path}")
            last_info = self.last_started.get(process_id, {})
            if not last_info.get('failed') and self.firebase_client:
                suggested_paths = self._find_sibling_executables(exe_path)
                self.firebase_client.send_alert('exe_missing', {
                    'process_name': process_name,
                    'process_id': process_id,
                    'exe_path': exe_path,
                    'suggested_paths': suggested_paths,
                })
                self.firebase_client.log_event(
                    'process_launch_failed',
                    'error',
                    process_name=process_name,
                    details=f'executable not found: {exe_path}'
                )
            self.last_started[process_id] = {'time': datetime.datetime.now(), 'pid': None, 'failed': True}
            # D5: reuses the entry's newest dead row so the desktop shows
            # "failed" instead of the hollow INACTIVE ring.
            _surface_launch_failed(process_id)
            return None

        if not self.reached_max_relaunch_attempts(process):
            process_list_id = process['id']
            delay = float(process.get('time_delay', 0))

            time_to_init = float(shared_utils.read_config(keys=['time_to_init'], process_list_id=process_list_id))

            last_info = self.last_started.get(process_list_id, {})
            last_time = last_info.get('time')

            if last_time is None or (last_time is not None and (self.current_time - last_time).total_seconds() >= (time_to_init or TIME_TO_INIT)):
                # Skip delay on first launch (delay is for crash recovery spacing,
                # not fresh starts) and on manual mode changes
                if last_time is None or last_info.get('failed') or process_list_id in self._skip_launch_delay:
                    self._skip_launch_delay.discard(process_list_id)
                elif delay:
                    time.sleep(delay)

                try:
                    pid = self.launch_process_as_user(process)
                except Exception as e:
                    logging.error(f"Could not start process {Util.get_process_name(process)}.\n {e}")
                    if self.firebase_client and self.firebase_client.is_connected():
                        self.firebase_client.log_event(
                            action='process_start_failed',
                            level='error',
                            process_name=Util.get_process_name(process),
                            details=str(e)
                        )
                        self.firebase_client.send_process_alert(
                            Util.get_process_name(process), str(e), 'process_start_failed'
                        )
                    self._write_cortex_event(Util.get_process_name(process), str(e), 'process_start_failed')
                    return None

                if pid is None:
                    logging.error(f"Launch returned no PID for {Util.get_process_name(process)} - will not track or retry this cycle")
                    # 'failed' makes handle_process back off. datetime.now(), NOT
                    # self.current_time: a blocking launch would otherwise date the
                    # cooldown from the loop start and expire it early.
                    self.last_started[process_list_id] = {'time': datetime.datetime.now(), 'pid': None, 'failed': True}
                    # D5: a no-PID launch is a failed launch - surface it.
                    _surface_launch_failed(process_list_id)
                    return None

                # Update the last started time and PID (use real time, not loop-start time)
                self.last_started[process_list_id] = {'time': datetime.datetime.now(), 'pid': pid}
                logging.info(f"PID {pid} started")

                if self.firebase_client and self.firebase_client.is_connected():
                    self.firebase_client.log_event(
                        action='process_started',
                        level='info',
                        process_name=Util.get_process_name(process),
                        details=f'PID {pid}'
                    )

                return pid  # Return the new PID

            return None  # Return None if the process was not started

    # If process not responding, attempt to kill and relaunch
    # Uses confirmation-based detection: process must be hung for HANG_CONFIRM_SECONDS before killing
    HANG_CONFIRM_SECONDS = 15  # Require ~3 consecutive checks (at 5s intervals) before killing

    def handle_unresponsive_process(self, pid, process):
        if not process.get('check_responsive', True):
            return None

        process_name = Util.get_process_name(process)
        try:
            process_results = self.results.get(str(pid), {})
            responsive = process_results.get('responsive', True)
            hung_since = process_results.get('hung_since', None)
        except Exception:
            logging.error("An unexpected error occurred")
            responsive = True
            hung_since = None

        if not responsive and hung_since:
            current_time = int(time.time())
            hung_duration = current_time - hung_since

            if hung_duration < 10:  # First detection (within first check cycle)
                logging.warning(f"Process {process_name} (PID {pid}) appears to be not responding, monitoring...")
                shared_utils.update_process_status_in_json(pid, 'STALLED', self.firebase_client, process_id=process.get('id'))
                return None  # Don't kill yet, wait for confirmation

            # Only kill after confirmed hang (multiple checks)
            if hung_duration >= self.HANG_CONFIRM_SECONDS:
                self.log_and_notify(
                    process,
                    f"Process {process_name} (PID {pid}) not responding for {hung_duration}s, restarting"
                )
                time.sleep(1)
                new_pid = self.kill_and_relaunch_process(pid, process)
                return new_pid
            else:
                logging.debug(f"Process {process_name} (PID {pid}) hung for {hung_duration}s, waiting for confirmation ({self.HANG_CONFIRM_SECONDS}s threshold)")
                return None

        return None

    def handle_process(self, process):
        process_list_id = process['id']

        # Skip processing entirely if this process is locked for an active deployment
        if process_list_id in self.install_locks:
            logging.debug(f"Skipping '{process.get('name')}' - install lock active (deployment: {self.install_locks[process_list_id]})")
            return

        last_info = self.last_started.get(process_list_id, {})

        # Manually killed: no relaunch. Cleared by set_launch_mode (mode back to
        # always/scheduled) or an explicit start_process.
        if last_info.get('killed'):
            return

        last_pid = last_info.get('pid')

        if self.first_start:
            if not last_pid:
                # It may have survived the service restart (AppKillProcessTree=0).
                exe_path = process.get('exe_path', '')
                file_path = process.get('file_path', '')
                existing_pid = self._find_running_process_by_exe(exe_path, file_path) if exe_path else None
                # INHERIT (D1): a match owlette did not launch binds only with
                # its identity recorded; unreadable identity (died between
                # match and read) is a no-match and launches fresh instead.
                inherit_extra = _inherit_identity_extra(existing_pid) if existing_pid else None
                if existing_pid and inherit_extra:
                    self.last_started[process_list_id] = {
                        'time': datetime.datetime.now(),
                        'pid': existing_pid
                    }
                    shared_utils.update_process_status_in_json(existing_pid, 'RUNNING', self.firebase_client, process_id=process_list_id, extra=inherit_extra)
                    logging.info(f"[OK] Adopted already-running '{process.get('name')}' (PID {existing_pid})")
                    new_pid = None
                else:
                    new_pid = self.handle_process_launch(process)
            else:
                shared_utils.update_process_status_in_json(last_pid, 'RUNNING', self.firebase_client, process_id=process_list_id)
                logging.debug(f"Using recovered process '{process.get('name')}' with PID {last_pid}")
                new_pid = None  # Don't update last_started since it's already set

        else:
            # PID detection can fail on a successful launch, so scan by
            # exe+cmdline before launching again.
            if last_info.get('failed'):
                exe_path = process.get('exe_path', '')
                file_path = process.get('file_path', '')
                found_pid = self._find_running_process_by_exe(exe_path, file_path) if exe_path else None
                # INHERIT (D1): same rule as the first-start adoption above --
                # record identity at bind time or treat the match as absent
                # (the cooldown/relaunch path below continues either way).
                inherit_extra = _inherit_identity_extra(found_pid) if found_pid else None
                if found_pid and inherit_extra:
                    self.last_started[process_list_id] = {
                        'time': datetime.datetime.now(),
                        'pid': found_pid
                    }
                    shared_utils.update_process_status_in_json(found_pid, 'RUNNING', self.firebase_client, process_id=process_list_id, extra=inherit_extra)
                    logging.info(f"[OK] Adopted '{Util.get_process_name(process)}' after failed PID detection (PID {found_pid})")
                    return
                # max(time_to_init, 60s). The 60s floor stops slow apps
                # (TouchDesigner) being double-launched before psutil sees them.
                last_time = last_info.get('time')
                if last_time:
                    time_to_init = max(float(process.get('time_to_init', 0) or TIME_TO_INIT), 60.0)
                    elapsed = (self.current_time - last_time).total_seconds()
                    if elapsed < time_to_init:
                        return  # Still cooling down, skip this cycle

            if last_pid and Util.is_pid_running(last_pid):
                last_time = last_info.get('time')
                time_to_init = float(process.get('time_to_init', 0) or TIME_TO_INIT)
                if last_time and (self.current_time - last_time).total_seconds() < time_to_init:
                    shared_utils.update_process_status_in_json(last_pid, 'LAUNCHING', self.firebase_client, process_id=process_list_id)
                    new_pid = None
                else:
                    self.launch_python_script_as_user(
                        shared_utils.get_path('owlette_scout.py'),
                        str(last_pid)
                    )
                    new_pid = self.handle_unresponsive_process(last_pid, process)

                if not new_pid:
                    shared_utils.update_process_status_in_json(last_pid, 'RUNNING', self.firebase_client, process_id=process_list_id)

            else:
                if last_pid:
                    # KILLED = service/dashboard kill, RESTARTING = operator via
                    # the local app. Both are intended exits; only RESTARTING
                    # earns an audit event.
                    try:
                        results = shared_utils.read_json_from_file(shared_utils.RESULT_FILE_PATH)
                        if results is None:
                            results = {}
                        process_status = results.get(str(last_pid), {}).get('status', '')
                    except Exception as e:
                        logging.warning(f"Error checking manual kill status: {e}")
                        process_status = ''
                    was_manually_killed = (process_status == 'KILLED')
                    was_restarted = (process_status == PROCESS_RESTARTING_STATUS)

                    if self._shutting_down:
                        logging.debug(f"Process {last_pid} stopped during reboot/shutdown - skipping crash alert")
                    elif was_restarted:
                        # The desktop app has no Firebase client, so the service
                        # writes the event the legacy GUI used to. Relaunch still
                        # goes through the normal autolaunch path below.
                        process_name = Util.get_process_name(process)
                        logging.info(f"Process {last_pid} ('{process_name}') was restarted from the local app - skipping crash alert")
                        if self.firebase_client and self.firebase_client.is_connected():
                            self.firebase_client.log_event(
                                action='process_restarted',
                                level='info',
                                process_name=process_name,
                                details=f'Manual restart from the local app - terminated PID {last_pid} (service will relaunch on next tick)'
                            )
                    elif was_manually_killed:
                        logging.debug(f"Process {last_pid} was manually killed - skipping crash log")
                    else:
                        process_name = Util.get_process_name(process)

                        # Best-effort screenshot capture before relaunch
                        crash_screenshot_url = None
                        try:
                            crash_screenshot_url = self._capture_crash_screenshot()
                        except Exception:
                            pass

                        if self.firebase_client and self.firebase_client.is_connected():
                            self.firebase_client.log_event(
                                action='process_crash',
                                level='error',
                                process_name=process_name,
                                details=f'Process stopped unexpectedly (PID {last_pid} no longer running)',
                                screenshot_url=crash_screenshot_url
                            )
                            self.firebase_client.send_process_alert(
                                process_name, f'Process stopped unexpectedly (PID {last_pid} no longer running)', 'process_crash'
                            )
                        self._write_cortex_event(process_name, f'Process stopped unexpectedly (PID {last_pid} no longer running)', 'process_crash')

                # Re-read: the GUI or Firestore may have changed launch_mode since
                # the loop iteration began.
                fresh_config = shared_utils.read_config()
                fresh_processes = fresh_config.get('processes', []) if fresh_config else []
                fresh_process = next((p for p in fresh_processes if p.get('id') == process_list_id), None)
                fresh_mode = fresh_process.get('launch_mode', 'always' if fresh_process.get('autolaunch', False) else 'off') if fresh_process else 'off'
                if fresh_mode == 'off' or (fresh_mode == 'scheduled' and not shared_utils.is_within_schedule(fresh_process.get('schedules') if fresh_process else None, self._cached_site_timezone)):
                    logging.debug(f"Skipping relaunch of '{Util.get_process_name(process)}' - launch_mode is '{fresh_mode}' (not active)")
                    # Nothing is going to supersede the dead pid's row now, so
                    # retire it here: this is the ONE place the service both
                    # knows the process is gone and has decided not to start it
                    # again. Left alone, the entry reads green in the desktop and
                    # the dashboard until the five-minute sweep.
                    #
                    # Not while shutting down: that path suppresses its side
                    # effects on the way out, and startup re-derives the file
                    # anyway (recover_running_processes drops every dead pid, and
                    # a row this would retire could never have been re-adopted --
                    # adoption needs the pid still alive).
                    if not self._shutting_down:
                        _retire_dead_status_row(self, last_pid, process_list_id)
                    # Clear last_started so we don't keep detecting it as crashed
                    if process_list_id in self.last_started:
                        del self.last_started[process_list_id]
                    new_pid = None
                else:
                    # A previous launch may have succeeded with PID detection failing.
                    exe_path = process.get('exe_path', '')
                    file_path = process.get('file_path', '')
                    existing_pid = self._find_running_process_by_exe(exe_path, file_path) if exe_path else None
                    # INHERIT (D1): record identity at bind time, or treat the
                    # match as absent and fall through to the fresh launch.
                    inherit_extra = _inherit_identity_extra(existing_pid) if existing_pid else None
                    if existing_pid and inherit_extra:
                        self.last_started[process_list_id] = {
                            'time': datetime.datetime.now(),
                            'pid': existing_pid
                        }
                        shared_utils.update_process_status_in_json(existing_pid, 'RUNNING', self.firebase_client, process_id=process_list_id, extra=inherit_extra)
                        logging.info(f"[OK] Adopted already-running '{Util.get_process_name(process)}' (PID {existing_pid})")
                        new_pid = None
                    else:
                        # Keep failed markers so missing-exe alerts fire only on
                        # transition; clearing other stale entries makes the
                        # relaunch fresh and skips time_delay.
                        if last_info.get('failed'):
                            self._skip_launch_delay.add(process_list_id)
                        else:
                            self.last_started.pop(process_list_id, None)
                        new_pid = self.handle_process_launch(process)
        
        # Real time, not loop-start, so cooldowns measure from the actual launch.
        if new_pid:
            self.last_started[process_list_id] = {'time': datetime.datetime.now(), 'pid': new_pid}

    def cleanup_stale_tracking_data(self):
        """
        Remove entries from tracking dictionaries for processes that no longer exist in config.
        Prevents memory leaks from accumulation over time.
        """
        try:
            config = shared_utils.read_config()
            if not config:
                return

            current_process_ids = {p.get('id') for p in config.get('processes', []) if p.get('id')}

            stale_ids = [pid for pid in self.last_started.keys() if pid not in current_process_ids]
            if stale_ids:
                for pid in stale_ids:
                    del self.last_started[pid]
                logging.info(f"[OK] Cleaned up {len(stale_ids)} stale entries from last_started tracking")

            current_process_names = {p.get('name') for p in config.get('processes', []) if p.get('name')}
            stale_names = [name for name in self.relaunch_attempts.keys() if name not in current_process_names]
            if stale_names:
                for name in stale_names:
                    del self.relaunch_attempts[name]
                logging.info(f"[OK] Cleaned up {len(stale_names)} stale entries from relaunch_attempts tracking")

            stale_locks = [pid for pid in self.install_locks.keys() if pid not in current_process_ids]
            if stale_locks:
                for pid in stale_locks:
                    del self.install_locks[pid]
                logging.info(f"[OK] Cleaned up {len(stale_locks)} stale entries from install_locks")

            stale_installs = [pid for pid in self.active_installations.keys() if pid not in current_process_ids]
            if stale_installs:
                for pid in stale_installs:
                    del self.active_installations[pid]
                logging.info(f"[OK] Cleaned up {len(stale_installs)} stale entries from active_installations")

            stale_overrides = [pid for pid in self.manual_overrides.keys() if pid not in current_process_ids]
            if stale_overrides:
                for pid in stale_overrides:
                    del self.manual_overrides[pid]
                logging.info(f"[OK] Cleaned up {len(stale_overrides)} stale entries from manual_overrides")

            stale_skips = self._skip_launch_delay - current_process_ids
            if stale_skips:
                self._skip_launch_delay -= stale_skips
                logging.info(f"[OK] Cleaned up {len(stale_skips)} stale entries from _skip_launch_delay")

            # Clean up app_states.json (results file) — remove PIDs that no longer exist
            if self.results:
                # First pass: which entries still have a row whose pid is
                # alive -- needed so a LAUNCH_FAILED surfacing row is kept
                # only while it is still the entry's story (see below).
                live_entry_ids = set()
                dead_rows = []
                for pid_str, row in self.results.items():
                    try:
                        pid_int = int(pid_str)
                    except (TypeError, ValueError):
                        # A non-numeric key (e.g. "None" from a failed launch)
                        # must not abort the whole sweep via the broad except
                        # below -- skip just this key and keep sweeping.
                        logging.debug(f"Skipping non-numeric PID key '{pid_str}' in app_states cleanup")
                        continue
                    # Identity, not bare liveness: a recycled pid would keep a
                    # dead row alive forever, which is the one way the stale
                    # green survives past this sweep entirely.
                    if _pid_still_ours(pid_int, row):
                        if isinstance(row, dict) and row.get('id'):
                            live_entry_ids.add(row['id'])
                    else:
                        dead_rows.append((pid_str, row))
                stale_pids = []
                for pid_str, row in dead_rows:
                    # WHY a dead LAUNCH_FAILED row survives the sweep: it is
                    # the D5 surfacing row for an entry that cannot launch,
                    # and a failed launch has no live pid BY DEFINITION.
                    # Sweeping it would flip the entry back to the hollow
                    # INACTIVE ring within one cleanup interval -- the exact
                    # invisibility the status exists to end -- with no row
                    # left for _surface_launch_failed to reuse. It is kept
                    # only while it is still the entry's story: the entry is
                    # still configured and no live row has superseded it. A
                    # successful launch or inherit creates a live row, and
                    # the next sweep clears this leftover.
                    if (isinstance(row, dict)
                            and row.get('status') == 'LAUNCH_FAILED'
                            and row.get('id') in current_process_ids
                            and row.get('id') not in live_entry_ids):
                        continue
                    stale_pids.append(pid_str)
                if stale_pids:
                    for pid_str in stale_pids:
                        del self.results[pid_str]
                    shared_utils.write_json_to_file(self.results, shared_utils.RESULT_FILE_PATH)
                    logging.info(f"[OK] Cleaned up {len(stale_pids)} stale PID entries from app_states.json")

        except Exception as e:
            logging.error(f"Error cleaning up stale tracking data: {e}")

    def _relaunch_if_restarting(self, process):
        """Honour a desktop-app restart of a process whose launch mode is off.

        handle_process() is never called for an off process, so the RESTARTING
        marker it looks for (PROCESS_RESTARTING_STATUS) would otherwise turn a
        restart into a plain stop. Restart means restart whatever the mode:
        once every marked pid is gone, launch once, log it, and go back to
        leaving the process alone.
        """
        process_id = process.get('id')
        if not process_id:
            return
        # Safety net for the rows the transition edge cannot catch: one written
        # while the entry was ALREADY off (a desktop restart's relaunch, an
        # adopted instance), or a transition the service was not running for.
        # The transition handler is what makes switching to off feel immediate;
        # this is what makes it eventually true regardless.
        _retire_dead_rows_for_entry(self, process_id)
        marked = [
            pid_str for pid_str, state in self.results.items()
            if isinstance(state, dict)
            and state.get('id') == process_id
            and state.get('status') == PROCESS_RESTARTING_STATUS
            and pid_str.isdigit()
        ]
        if not marked:
            return
        # The marker is written before the kill; the process takes a few
        # seconds to close (WM_CLOSE, grace, terminate). Wait for it.
        if any(Util.is_pid_running(int(pid_str)) for pid_str in marked):
            return

        for pid_str in marked:
            self.results.pop(pid_str, None)
        shared_utils.write_json_to_file(self.results, shared_utils.RESULT_FILE_PATH)

        process_name = Util.get_process_name(process)
        old_pids = ', '.join(marked)
        logging.info(f"'{process_name}' (PID {old_pids}) was restarted from the local app - relaunching once (launch mode is off)")
        if self.firebase_client and self.firebase_client.is_connected():
            self.firebase_client.log_event(
                action='process_restarted',
                level='info',
                process_name=process_name,
                details=f'Manual restart from the local app - terminated PID {old_pids}, relaunching once (launch mode is off)'
            )

        self.last_started.pop(process_id, None)
        self._skip_launch_delay.add(process_id)
        new_pid = self.handle_process_launch(process)
        if new_pid:
            # Tracked so a later dashboard kill/restart finds it without a scan;
            # off-mode processes are still never monitored.
            self.last_started[process_id] = {'time': datetime.datetime.now(), 'pid': new_pid}

    def _get_process_launch_mode(self, process):
        return process.get('launch_mode', 'always' if process.get('autolaunch', False) else 'off')

    def _get_schedule_signature(self, process):
        return json.dumps(process.get('schedules'), sort_keys=True, default=str)

    def _apply_launch_mode_transition(self, process_id, old_mode, new_mode, new_proc):
        name = new_proc.get('name')

        if old_mode == new_mode:
            logging.info(f"Launch schedule changed for {name} - will re-evaluate on next tick")
            return

        old_active = old_mode in ('always', 'scheduled')
        new_active = new_mode in ('always', 'scheduled')

        if new_mode == 'off' and old_active:
            logging.info(f"Launch mode set to off for {name} - stopping monitoring (process stays running)")
            self.manual_overrides.pop(process_id, None)
            # Settle the status HERE, not on some later tick. This is the last
            # moment the entry is still being monitored: from the next tick the
            # main loop routes an off entry away from handle_process entirely, so
            # a row left claiming RUNNING on a process the user already closed
            # has nothing left to correct it but the five-minute sweep. A live
            # process keeps its row (and the desktop's kill/restart controls) --
            # switching the mode off has never stopped anything and still
            # doesn't.
            _retire_dead_rows_for_entry(self, process_id)
            return

        if old_mode == 'off' and new_mode == 'always':
            logging.info(f"Launch mode set to always for {name} - launching now")
            self.last_started.pop(process_id, None)
            self._skip_launch_delay.add(process_id)
            self.relaunch_attempts.pop(name, None)
            try:
                self.handle_process(new_proc)
            except Exception as e:
                logging.error(f"Failed to immediately launch {name}: {e}")
            return

        if old_mode == 'off' and new_mode == 'scheduled':
            self.last_started.pop(process_id, None)
            self.relaunch_attempts.pop(name, None)
            should_launch = shared_utils.is_within_schedule(new_proc.get('schedules'), self._cached_site_timezone)
            if should_launch:
                logging.info(f"Launch mode set to scheduled for {name} - launching now")
                self._skip_launch_delay.add(process_id)
                try:
                    self.handle_process(new_proc)
                except Exception as e:
                    logging.error(f"Failed to immediately launch {name}: {e}")
            else:
                logging.info(f"Launch mode set to scheduled for {name} - outside schedule, will launch when window opens")
            return

        if old_active and new_active:
            logging.info(f"Launch mode changed for {name}: {old_mode} -> {new_mode}")
            return

        logging.info(f"Launch mode changed for {name}: {old_mode} -> {new_mode}")

    def _diff_and_apply_launch_modes(self, processes):
        current_process_ids = set()

        for process in processes or []:
            process_id = process.get('id')
            if not process_id:
                continue

            current_process_ids.add(process_id)
            old_mode = self._last_seen_launch_modes.get(process_id)
            new_mode = self._get_process_launch_mode(process)
            new_schedule_signature = self._get_schedule_signature(process)

            if old_mode is None:
                self._last_seen_launch_modes[process_id] = new_mode
                self._last_seen_launch_schedules[process_id] = new_schedule_signature
                continue

            old_schedule_signature = self._last_seen_launch_schedules.get(process_id)
            schedules_changed = (
                old_mode == new_mode == 'scheduled'
                and old_schedule_signature != new_schedule_signature
            )

            if old_mode == new_mode:
                if schedules_changed:
                    self._apply_launch_mode_transition(process_id, old_mode, new_mode, process)
                self._last_seen_launch_schedules[process_id] = new_schedule_signature
                continue

            # Mark seen BEFORE applying: apply can block for seconds (off->always
            # launches), and every other thread diffs this dict — updating it
            # after leaves a window to apply the same transition twice.
            self._last_seen_launch_modes[process_id] = new_mode
            self._last_seen_launch_schedules[process_id] = new_schedule_signature
            self._apply_launch_mode_transition(process_id, old_mode, new_mode, process)

        stale_process_ids = set(self._last_seen_launch_modes.keys()) - current_process_ids
        for process_id in stale_process_ids:
            self._last_seen_launch_modes.pop(process_id, None)
            self._last_seen_launch_schedules.pop(process_id, None)

    def start_local_config_watcher(self):
        """Poll config.json for locally-originated edits on a dedicated thread.

        Detection used to ride the 5s main loop, which put up to a full tick in
        front of every desktop-app edit before the upload even started — ~6s to
        the dashboard against an operator-facing target of 1-2s. A no-change tick
        here is one stat, so it can poll at LOCAL_CONFIG_POLL_INTERVAL and bring
        detection under half a second; the push itself is still single-flight and
        paced by PushBackoff.

        This is the ONLY caller of _check_local_config_changes. That method
        assumes a single invoker — single-flight dispatch, the mtime baseline
        CAS — so the main loop must not call it as well.

        Runs on its own daemon thread, like the SCM stop watcher, and stops with
        self.is_alive.
        """
        def _watch():
            consecutive_errors = 0
            while self.is_alive:
                try:
                    self._check_local_config_changes()
                    consecutive_errors = 0
                except Exception as e:
                    consecutive_errors += 1
                    # One bad tick must never kill the watcher, and at 2Hz a
                    # persistent fault would flood the log: first of an episode,
                    # then every 100th (~50s).
                    if consecutive_errors == 1 or consecutive_errors % 100 == 0:
                        logging.warning(
                            f"Local config watcher tick failed "
                            f"({consecutive_errors}): {e}"
                        )
                time.sleep(LOCAL_CONFIG_POLL_INTERVAL)

        thread = threading.Thread(
            target=_watch, name='owlette-local-config-watch', daemon=True)
        thread.start()
        logging.info(
            f"Local config watcher started (polling every {LOCAL_CONFIG_POLL_INTERVAL}s)")
        return thread

    def _check_local_config_changes(self):
        """Upload config.json edits that originated on this machine.

        Nothing has done this since the Tkinter GUI was removed in 3.0.0: the
        desktop app writes config.json, the main loop applies it, and the next
        pull silently reverted it. Called once per watcher tick, from
        start_local_config_watcher and nowhere else.

        Ordered cheapest-first — an unchanged mtime costs one stat and is the
        steady state, which is what lets the watcher poll twice a second. The
        upload runs on a short-lived daemon thread because detection must never
        block on the network, and only one is allowed in flight. The mtime
        baseline advances only once local and remote are known to agree, so a
        failed push is retried on a later tick that still sees the divergence —
        paced by PushBackoff, since a permanently failing push would otherwise
        retry twice a second forever.
        """
        try:
            mtime = os.path.getmtime(shared_utils.CONFIG_PATH)
        except OSError:
            return

        if self._local_config_mtime is not None and mtime == self._local_config_mtime:
            return

        if self._applying_remote_config:
            return

        if self._config_push_thread is not None and self._config_push_thread.is_alive():
            return

        # A different edit than the one that has been failing: try it at once,
        # however far the previous edit's backoff had grown.
        if mtime != self._push_attempt_mtime:
            self._push_backoff.reset()

        if not self._push_backoff.ready(time.monotonic()):
            return

        client = self.firebase_client
        if not client or not client.is_connected():
            return

        local_config = shared_utils.read_config()
        if not local_config:
            return

        # cached_config is the last-known REMOTE doc, refreshed by every pull and
        # by our own pushes.
        if config_sync.configs_equal(local_config, client.cached_config):
            with self._config_baseline_lock:
                self._local_config_mtime = mtime
            self._push_backoff.reset()
            return

        baseline_at_dispatch = self._local_config_mtime
        self._push_attempt_mtime = mtime

        def _push():
            try:
                if client.push_local_config(local_config, reason='local edit'):
                    with self._config_baseline_lock:
                        # Compare-and-set on the pre-push mtime. An edit landing
                        # mid-push leaves the baseline behind and is picked up on
                        # the next tick; a concurrent apply that already published
                        # a newer baseline (a foreign edit delivered while we were
                        # pushing) must not be walked back.
                        if self._local_config_mtime == baseline_at_dispatch:
                            self._local_config_mtime = mtime
                    self._push_backoff.reset()
                    # The dashboard draws process ROWS from metrics.processes, so
                    # a local add/delete/rename stays invisible until the next
                    # heartbeat — up to 120s idle. Remote applies already push
                    # metrics immediately (handle_config_update); mirror that
                    # here so both edit origins reflect within seconds.
                    try:
                        client._upload_metrics(shared_utils.get_system_metrics())
                        logging.info(
                            "Metrics pushed after local config push (for web dashboard responsiveness)")
                    except Exception as e:
                        logging.warning(
                            f"Post-push metrics upload failed (next heartbeat covers it): {e}")
                else:
                    delay = self._push_backoff.record_failure(time.monotonic())
                    logging.warning(
                        f"Local config push failed — next attempt in {delay:.0f}s")
            except Exception as e:
                delay = self._push_backoff.record_failure(time.monotonic())
                logging.warning(
                    f"Local config push thread failed ({e}) — "
                    f"next attempt in {delay:.0f}s")

        self._config_push_thread = threading.Thread(
            target=_push, name='owlette-config-push', daemon=True)
        self._config_push_thread.start()

    def handle_config_update(self, new_config):
        """
        Handle configuration updates from Firebase.
        Performs intelligent diffing to terminate removed processes and respect autolaunch changes.

        Args:
            new_config: New configuration dict from Firestore
        """
        # Suppresses the config watcher's local-change detector for the duration: the
        # write below moves config.json's mtime, and a pull must never be read
        # back as a local edit and pushed.
        self._applying_remote_config = True
        try:
            old_config = shared_utils.read_config()

            # A doc that already matches disk carries nothing to apply, and
            # applying it anyway rewrites config.json — which is how an edit made
            # in the gap gets lost to an echo of our own write.
            if old_config and config_sync.configs_equal(new_config, old_config):
                logging.debug(
                    "Config update from Firestore matches the local config — nothing to apply")
                return

            logging.info("Applying config update from Firestore")

            # NEVER let a Firestore sync overwrite these. `environment` is the
            # local dev/prod routing choice: a stale remote doc seeded on dev can
            # otherwise leave a prod `firebase` section beside a dev
            # `environment` — split-brain routing between the firebase client and
            # get_api_base_url().
            LOCAL_ONLY_KEYS = ('firebase', 'sentry', 'environment')
            if old_config:
                for key in LOCAL_ONLY_KEYS:
                    if key in old_config:
                        new_config[key] = old_config[key]
                logging.debug(f"Preserved local-only keys during Firestore sync: {[k for k in LOCAL_ONLY_KEYS if k in old_config]}")
            else:
                # Without the old config the write would wipe local-only settings.
                logging.error("CRITICAL: Cannot read old config - aborting Firestore config sync to prevent data loss")
                return

            # Keep local launch_mode/schedules when Firestore has none — the GUI
            # may have set them before Firestore caught up.
            merged_launch_mode = False
            if old_config:
                old_processes = {p.get('id'): p for p in old_config.get('processes', []) if p.get('id')}
                for process in new_config.get('processes', []):
                    pid = process.get('id')
                    if pid and pid in old_processes:
                        old_proc = old_processes[pid]
                        if 'launch_mode' not in process and 'launch_mode' in old_proc:
                            process['launch_mode'] = old_proc['launch_mode']
                            merged_launch_mode = True
                        if 'schedules' not in process and 'schedules' in old_proc:
                            process['schedules'] = old_proc['schedules']
                    if 'launch_mode' in process:
                        process['autolaunch'] = process['launch_mode'] != 'off'

            # A schedule edit is user intent and supersedes a pending attempt.
            old_reboot_schedule = (old_config or {}).get('rebootSchedule')
            new_reboot_schedule = new_config.get('rebootSchedule')
            if json.dumps(old_reboot_schedule, sort_keys=True) != json.dumps(new_reboot_schedule, sort_keys=True):
                try:
                    state = reboot_state.read_state()
                    if state.get('attempt') and state['attempt'].get('status') == 'pending':
                        logging.info("Reboot schedule changed mid-attempt — clearing pending attempt")
                        state = reboot_state.clear_attempt(state)
                        reboot_state.write_state(state)
                        if self.firebase_client:
                            self.firebase_client.mirror_reboot_state(state)
                            self.firebase_client.log_event(
                                action='scheduled_reboot_cancelled',
                                level='info',
                                details='schedule changed during pending attempt'
                            )
                        self._reboot_attempt_started_monotonic = None
                except Exception as e:
                    logging.warning(f"Failed to handle reboot schedule change: {e}")

            shared_utils.write_json_to_file(new_config, shared_utils.CONFIG_PATH)

            logging.info("Local config.json updated from Firestore")

            # Push the merged launch_mode back, or the sync cycle never settles.
            # push_local_config, not upload_config: it re-anchors the echo guard
            # on the post-write document, so this write doesn't come straight
            # back through the listener as a foreign change.
            if merged_launch_mode and self.firebase_client and self.firebase_client.is_connected():
                try:
                    self.firebase_client.push_local_config(
                        new_config, reason='launch_mode merge-back')
                except Exception as e:
                    logging.error(f"Failed to push launch_mode to Firestore: {e}")

            # Check for Firebase enable/disable changes (site rejoining detection)
            if old_config:
                old_firebase_config = old_config.get('firebase', {})
                new_firebase_config = new_config.get('firebase', {})

                old_firebase_enabled = old_firebase_config.get('enabled', False)
                new_firebase_enabled = new_firebase_config.get('enabled', False)
                old_site_id = old_firebase_config.get('site_id')
                new_site_id = new_firebase_config.get('site_id')

                if not old_firebase_enabled and new_firebase_enabled:
                    logging.debug("=" * 60)
                    logging.info("Firebase has been RE-ENABLED - reinitializing Firebase client")
                    logging.debug(f"Site ID: {new_site_id}")
                    logging.debug("=" * 60)

                    success = self._initialize_or_restart_firebase_client()
                    if success:
                        logging.info("[OK] Firebase client restarted successfully after being re-enabled")
                    else:
                        logging.error("[ERROR] Failed to restart Firebase client after being re-enabled")

                elif old_firebase_enabled and new_firebase_enabled and old_site_id != new_site_id:
                    logging.debug("=" * 60)
                    logging.info(f"Site ID CHANGED: {old_site_id} -> {new_site_id}")
                    logging.debug("Reinitializing Firebase client for new site")
                    logging.debug("=" * 60)

                    success = self._initialize_or_restart_firebase_client()
                    if success:
                        logging.info("[OK] Firebase client restarted successfully for new site")
                    else:
                        logging.error("[ERROR] Failed to restart Firebase client for new site")

            if old_config:
                old_processes = old_config.get('processes', [])
                new_processes = new_config.get('processes', [])

                old_process_map = {p.get('id'): p for p in old_processes if p.get('id')}
                new_process_map = {p.get('id'): p for p in new_processes if p.get('id')}

                removed_process_ids = set(old_process_map.keys()) - set(new_process_map.keys())

                for removed_id in removed_process_ids:
                    removed_proc = old_process_map[removed_id]
                    logging.info(f"Process removed from config: {removed_proc.get('name')}")

                    if removed_id in self.last_started:
                        pid_info = self.last_started[removed_id]
                        pid = pid_info.get('pid')

                        if pid and Util.is_pid_running(pid):
                            # The identity gate (D1): a removed entry's pid is
                            # only terminated if it is still provably the
                            # recorded process. exe_path rides along so a
                            # .bat wrapper's payload is reaped with it.
                            allowed, why = _identity_gate(pid, removed_id)
                            if not allowed:
                                # No LAUNCH_FAILED surfacing here (deliberate):
                                # the entry is no longer in config, so neither
                                # UI has a row to show the status on, and the
                                # stale-row sweep keeps LAUNCH_FAILED only for
                                # configured entries. The warning is the record.
                                logging.warning(
                                    f"Refusing to terminate removed process "
                                    f"'{removed_proc.get('name')}' (PID {pid}): {why}")
                            else:
                                try:
                                    shared_utils.graceful_terminate(
                                        pid, exe_path=removed_proc.get('exe_path'))
                                    shared_utils.update_process_status_in_json(pid, 'STOPPED', self.firebase_client, process_id=removed_id)
                                    logging.info(f"[OK] Terminated removed process: {removed_proc.get('name')} (PID {pid})")
                                except Exception as e:
                                    logging.error(f"Failed to terminate removed process PID {pid}: {e}")

                        del self.last_started[removed_id]
                    self._last_seen_launch_modes.pop(removed_id, None)
                    self._last_seen_launch_schedules.pop(removed_id, None)

                for process_id, new_proc in new_process_map.items():
                    if process_id in old_process_map:
                        old_proc = old_process_map[process_id]
                        old_mode = self._get_process_launch_mode(old_proc)
                        new_mode = self._get_process_launch_mode(new_proc)
                        schedules_changed = (
                            old_mode == new_mode == 'scheduled'
                            and self._get_schedule_signature(old_proc) != self._get_schedule_signature(new_proc)
                        )

                        if old_mode != new_mode or schedules_changed:
                            # Seen-state first (see _diff_and_apply_launch_modes):
                            # the monitor loop diffs this dict concurrently.
                            self._last_seen_launch_modes[process_id] = new_mode
                            self._last_seen_launch_schedules[process_id] = self._get_schedule_signature(new_proc)
                            self._apply_launch_mode_transition(process_id, old_mode, new_mode, new_proc)

                logging.info(f"Config update complete - Processes: {len(old_processes)} -> {len(new_processes)}, Removed: {len(removed_process_ids)}")

            # Observational only — apply work belongs to apply_display_topology.
            # `displays` merges normally; it is deliberately NOT a LOCAL_ONLY_KEY.
            try:
                old_displays = (old_config or {}).get('displays')
                new_displays = new_config.get('displays')
                if json.dumps(old_displays, sort_keys=True) != json.dumps(new_displays, sort_keys=True):
                    old_enabled = bool((old_displays or {}).get('enabled'))
                    new_enabled = bool((new_displays or {}).get('enabled'))
                    old_layout_count = len(((old_displays or {}).get('savedLayouts') or []))
                    new_layout_count = len(((new_displays or {}).get('savedLayouts') or []))
                    logging.info(
                        f"Displays config changed: enabled {old_enabled}->{new_enabled}, "
                        f"savedLayouts {old_layout_count}->{new_layout_count}"
                    )
            except Exception as e:
                logging.debug(f"Displays config diff failed (non-critical): {e}")

            # Metrics, not config: the config doc is already what we just applied.
            # Pushed now so process states on the dashboard match the new config
            # without waiting out the metrics interval.
            if self.firebase_client and self.firebase_client.is_connected():
                try:
                    metrics = shared_utils.get_system_metrics()
                    self.firebase_client._upload_metrics(metrics)
                    logging.info("Metrics pushed after config apply (for web dashboard responsiveness)")
                except Exception as e:
                    logging.error(f"Failed to push metrics after config apply: {e}")
                    logging.info("Metrics will sync on next metrics interval")

        except Exception as e:
            logging.error(f"Error handling config update: {e}")
        finally:
            self._applying_remote_config = False
            # Adopt the mtime this apply produced, so the detector's next tick
            # compares against the config the pull just wrote.
            try:
                applied_mtime = os.path.getmtime(shared_utils.CONFIG_PATH)
            except OSError:
                applied_mtime = None
            with self._config_baseline_lock:
                self._local_config_mtime = applied_mtime

    def _terminate_processes_for_install(self, close_processes, suppress_projects, deployment_id, cmd_id):
        """Gracefully terminate MANAGED processes and set install locks before
        a deployment.

        D4: close_processes names resolve against config entries whose exe
        basename matches, then against those entries' RECORDED pids (managed
        or inherited), each identity-verified before the terminate. The old
        machine-wide psutil name scan is gone -- it killed every process on
        the box wearing the image name, managed or not. A name matching no
        managed entry is logged and skipped: owlette has no business
        terminating processes it does not manage, whatever their image name.

        Args:
            close_processes: List of exe names to close (e.g., ["TouchDesigner.exe"])
            suppress_projects: List of owlette project config IDs to lock from relaunching
            deployment_id: Deployment ID for logging and lock tracking
            cmd_id: Command ID for progress reporting

        Returns:
            List of project config IDs that were locked (for cleanup in finally block)
        """
        locked_project_ids = []

        if self.firebase_client:
            self.firebase_client.update_command_progress(cmd_id, 'closing_processes', deployment_id)

        config = shared_utils.read_config()
        config_processes = config.get('processes', []) if config else []
        terminated_any = False

        def _gated_terminate(pid, entry_id, entry_name, exe_path):
            """Identity-gate then terminate one managed pid; True if killed."""
            allowed, why = _identity_gate(pid, entry_id)
            if not allowed:
                logging.warning(
                    f"Refusing deployment terminate of '{entry_name}' "
                    f"(PID {pid}): {why}")
                # D5: surface the refusal on the row involved.
                _surface_launch_failed(entry_id, pid=pid)
                return False
            logging.info(f"Terminating managed process '{entry_name}' (PID {pid}) for deployment")
            try:
                # exe_path so a .bat wrapper's payload is reaped with it.
                shared_utils.graceful_terminate(pid, exe_path=exe_path)
                shared_utils.update_process_status_in_json(pid, 'STOPPED', self.firebase_client, process_id=entry_id)
                return True
            except Exception as e:
                logging.warning(f"Failed to terminate managed process PID {pid}: {e}")
                return False

        for project_id in suppress_projects:
            self.install_locks[project_id] = deployment_id
            locked_project_ids.append(project_id)
            logging.info(f"Install lock set for project {project_id} (deployment: {deployment_id})")

            last_info = self.last_started.get(project_id, {})
            pid = last_info.get('pid')
            if pid:
                entry = next((p for p in config_processes if p.get('id') == project_id), None)
                if _gated_terminate(pid, project_id, (entry or {}).get('name', '?'),
                                    (entry or {}).get('exe_path')):
                    terminated_any = True
                # Clear tracking so handle_process doesn't see a stale PID after
                # lock release -- also on a refusal, where tracking was lying.
                self.last_started.pop(project_id, None)

        for exe_name in close_processes:
            exe_name_lower = (exe_name or '').lower()
            matching_entries = [
                p for p in config_processes
                if os.path.basename(
                    (p.get('exe_path') or '').replace('/', '\\').lower()) == exe_name_lower
            ]
            if not matching_entries:
                logging.info(
                    f"close_processes name '{exe_name}' matches no managed config "
                    f"entry - skipping (owlette only terminates processes it manages)")
                continue
            for entry in matching_entries:
                entry_id = entry.get('id')
                # Recorded pids only: the tracked pid plus whatever the durable
                # identity record proves is still ours (they usually coincide;
                # after a restart only the record survives).
                candidate_pids = []
                tracked_pid = self.last_started.get(entry_id, {}).get('pid')
                if tracked_pid:
                    candidate_pids.append(tracked_pid)
                recorded_pid = _resolve_recorded_pid(entry_id)
                if recorded_pid and recorded_pid not in candidate_pids:
                    candidate_pids.append(recorded_pid)
                if not candidate_pids:
                    logging.info(
                        f"No recorded instance of managed entry '{entry.get('name')}' "
                        f"for close_processes name '{exe_name}' - nothing to terminate")
                    continue
                for pid in candidate_pids:
                    if _gated_terminate(pid, entry_id, entry.get('name', '?'),
                                        entry.get('exe_path')):
                        terminated_any = True
                        # Killing a tracked pid without clearing tracking would
                        # read as a crash on the next monitor tick.
                        if self.last_started.get(entry_id, {}).get('pid') == pid:
                            self.last_started.pop(entry_id, None)

        if terminated_any:
            # Wait for file handles to release after process termination
            time.sleep(2)

        killed_summary = []
        if suppress_projects:
            killed_summary.append(f"{len(suppress_projects)} managed project(s) locked")
        if close_processes:
            killed_summary.append(
                f"resolved {', '.join(close_processes)} against managed entries")
        logging.info(f"Pre-install process termination complete: {'; '.join(killed_summary)}")

        return locked_project_ids

    # Handle commands from Firebase
    # Command rate limiting: tracks last execution time per command type
    _command_rate_limits = {}
    # Minimum seconds between commands of the same type
    COMMAND_RATE_LIMIT_SECONDS = 5

    def handle_firebase_command(self, cmd_id, cmd_data):
        """
        Handle commands received from Firebase web portal.

        Args:
            cmd_id: Command ID
            cmd_data: Command data dict with 'type' and parameters

        Returns:
            Result message string
        """
        try:
            cmd_type = cmd_data.get('type')
            logging.info(f"Received Firebase command: {cmd_type} (ID: {cmd_id})")

            # Per-type throttle. mcp_tool_call is exempt: hoot fires parallel
            # tool calls by design and is gated server-side. ack_display_topology
            # is exempt because a dropped ack forces an auto-revert.
            if cmd_type not in ('mcp_tool_call', 'ack_display_topology'):
                now = time.time()
                rate_key = f"{cmd_type}:{cmd_data.get('process_id') or cmd_data.get('processId') or cmd_data.get('process_name') or ''}"
                last_time = self._command_rate_limits.get(rate_key, 0)
                if now - last_time < self.COMMAND_RATE_LIMIT_SECONDS:
                    logging.warning(f"Command rate-limited: {cmd_type} (last executed {now - last_time:.1f}s ago)")
                    return f"Error: rate limited - {cmd_type} executed too recently, try again in a few seconds"
                self._command_rate_limits[rate_key] = now

            # Router first; unregistered types fall through to the legacy
            # if/elif chain below.
            if self._command_router.has_handler(cmd_type):
                try:
                    return self._command_router.dispatch(cmd_type, cmd_data, cmd_id, self)
                except Exception as e:
                    # Handlers fail by returning "Error: ..." or by raising.
                    # firebase_client._execute_command decides completed-vs-failed
                    # purely on that prefix, so an uncaught raise would be
                    # recorded as a SUCCESS.
                    logging.error(
                        f"Command handler for '{cmd_type}' raised: {e}",
                        exc_info=True,
                    )
                    return f"Error: {cmd_type} failed: {e}"

            if cmd_type in ('restart_process', 'start_process'):
                process_name = cmd_data.get('process_name')
                process_id = cmd_data.get('process_id') or cmd_data.get('processId')
                processes = shared_utils.read_config(['processes'])
                for process in processes:
                    if (
                        (process_id and process.get('id') == process_id)
                        or (process_name and process.get('name') == process_name)
                    ):
                        process_name = process.get('name') or process_name
                        process_list_id = process['id']
                        # Track manual override for scheduled processes started outside window
                        mode = process.get('launch_mode', 'always' if process.get('autolaunch', False) else 'off')
                        if mode == 'scheduled' and not shared_utils.is_within_schedule(process.get('schedules'), self._cached_site_timezone):
                            self.manual_overrides[process_list_id] = True
                            logging.info(f"Manual override set for '{process_name}' (started outside schedule window)")
                        last_info = self.last_started.get(process_list_id, {})
                        last_pid = last_info.get('pid')
                        if cmd_type == 'start_process':
                            if last_pid and Util.is_pid_running(last_pid):
                                return f"Process {process_name} is already running with PID {last_pid}"
                            # An empty last_started is NOT proof of absence:
                            # off-mode processes are never adopted, so a live
                            # instance leaves it empty and a bare last_pid test
                            # launches a duplicate on top.
                            adopted_pid = self._adopt_running_instance(process)
                            if adopted_pid:
                                return (f"Process {process_name} is already running with "
                                        f"PID {adopted_pid} (discovered by exe/file_path lookup)")
                            self.last_started.pop(process_list_id, None)
                            new_pid = self.handle_process_launch(process)
                            if self.firebase_client and self.firebase_client.is_connected():
                                self.firebase_client.log_event(
                                    action='command_executed',
                                    level='info',
                                    process_name=process_name,
                                    details=f'Start process command - PID: {new_pid}'
                                )
                            return f"Process {process_name} started with PID {new_pid}"
                        if last_pid and Util.is_pid_running(last_pid):
                            # The identity gate (D1): the tracked pid must
                            # still be the recorded process before it is
                            # terminated for the relaunch.
                            # _kill_and_relaunch_locked re-checks, but refusing
                            # HERE gives the dashboard its Error: string (the
                            # prefix it parses) with the entry, pid and reason.
                            allowed, why = _identity_gate(last_pid, process_list_id)
                            if not allowed:
                                if self.last_started.get(process_list_id, {}).get('pid') == last_pid:
                                    self.last_started.pop(process_list_id, None)
                                # D5: surface the refusal on the row involved.
                                _surface_launch_failed(process_list_id, pid=last_pid)
                                return (f"Error: refusing to restart '{process_name}' "
                                        f"(PID {last_pid}): {why}")
                            new_pid = self.kill_and_relaunch_process(last_pid, process)
                            if self.firebase_client and self.firebase_client.is_connected():
                                self.firebase_client.log_event(
                                    action='command_executed',
                                    level='info',
                                    process_name=process_name,
                                    details=f'Restart process command - Old PID: {last_pid}, New PID: {new_pid}'
                                )
                            return f"Process {process_name} restarted with new PID {new_pid}"
                        else:
                            new_pid = self.handle_process_launch(process)
                            if self.firebase_client and self.firebase_client.is_connected():
                                self.firebase_client.log_event(
                                    action='command_executed',
                                    level='info',
                                    process_name=process_name,
                                    details=f'Start process command - PID: {new_pid}'
                                )
                            return f"Process {process_name} started with PID {new_pid}"
                target = process_id or process_name
                return f"Process {target} not found in configuration"

            elif cmd_type in ('kill_process', 'stop_process'):
                process_name = cmd_data.get('process_name')
                process_id = cmd_data.get('process_id') or cmd_data.get('processId')
                processes = shared_utils.read_config(['processes'])
                for process in processes:
                    if (
                        (process_id and process.get('id') == process_id)
                        or (process_name and process.get('name') == process_name)
                    ):
                        process_name = process.get('name') or process_name
                        process_list_id = process['id']
                        # The identity gate (D1) lives inside the resolver:
                        # the tracked pid is proven against its recorded row,
                        # the durable record substitutes for tracking after a
                        # service restart, and a strict-discovery hit (never a
                        # bare image-name match) is only killable on identity
                        # read at this moment. Refusals come back as Error:
                        # strings -- the prefix the dashboard parses.
                        target_pid, note, refusal = _resolve_kill_target(self, process)
                        if refusal:
                            return f"Error: {refusal}"
                        if target_pid:
                            shared_utils.graceful_terminate(
                                target_pid, exe_path=process.get('exe_path'))
                            status = 'STOPPED' if cmd_type == 'stop_process' else 'KILLED'
                            action = 'process_stopped' if cmd_type == 'stop_process' else 'process_killed'
                            details = (
                                f'Manual stop via dashboard - PID: {target_pid}{note}'
                                if cmd_type == 'stop_process'
                                else f'Manual kill via dashboard - PID: {target_pid}{note}'
                            )
                            shared_utils.update_process_status_in_json(target_pid, status, self.firebase_client, process_id=process_list_id)
                            # Killed, NOT deleted: an empty last_started reads as
                            # "untracked, needs launch" if the mode=off config
                            # hasn't synced to disk yet.
                            self.last_started[process_list_id] = {'killed': True, 'time': datetime.datetime.now()}
                            if self.firebase_client and self.firebase_client.is_connected():
                                self.firebase_client.log_event(
                                    action=action,
                                    level='warning',
                                    process_name=process_name,
                                    details=details
                                )
                            return f"Process {process_name} (PID {target_pid}) terminated"
                        else:
                            return f"Process {process_name} is not running"
                target = process_id or process_name
                return f"Process {target} not found in configuration"

            elif cmd_type in ('toggle_autolaunch', 'set_launch_mode'):
                process_name = cmd_data.get('process_name')
                process_id = cmd_data.get('process_id') or cmd_data.get('processId')
                config = shared_utils.read_config()
                processes = config.get('processes', [])
                process = None
                if process_id:
                    process = next((p for p in processes if p.get('id') == process_id), None)
                if process is None and process_name:
                    process = next((p for p in processes if p.get('name') == process_name), None)

                if process:
                    process_name = process.get('name') or process_name
                    process_id = process.get('id')
                    old_mode = self._get_process_launch_mode(process)
                    old_schedule_signature = self._get_schedule_signature(process)

                    if cmd_type == 'set_launch_mode':
                        new_mode = cmd_data.get('mode', 'off')
                        new_schedules = cmd_data.get('schedules', None)
                        process['launch_mode'] = new_mode
                        if new_schedules is not None:
                            process['schedules'] = new_schedules
                    else:
                        # Legacy toggle_autolaunch support
                        new_autolaunch_value = cmd_data.get('autolaunch', False)
                        process['launch_mode'] = 'always' if new_autolaunch_value else 'off'
                    # Always derive autolaunch for backward compat
                    process['autolaunch'] = process.get('launch_mode', 'off') != 'off'
                    shared_utils.save_config(config)
                    new_mode = process['launch_mode']
                    new_schedule_signature = self._get_schedule_signature(process)
                    logging.info(f"Launch mode for {process_name} set to {new_mode}")

                    schedules_changed = (
                        old_mode == new_mode == 'scheduled'
                        and old_schedule_signature != new_schedule_signature
                    )
                    if old_mode != new_mode or schedules_changed:
                        # Seen-state first (see _diff_and_apply_launch_modes):
                        # save_config already published the mode, so the monitor
                        # loop would otherwise fire this same off->always launch.
                        self._last_seen_launch_modes[process_id] = new_mode
                        self._last_seen_launch_schedules[process_id] = new_schedule_signature
                        self._apply_launch_mode_transition(process_id, old_mode, new_mode, process)

                    return f"Launch mode for {process_name} set to {new_mode}"
                target = process_id or process_name
                return f"Process {target} not found in configuration"

            elif cmd_type == 'update_config':
                new_config = cmd_data.get('config')
                if new_config:
                    # CRITICAL: Preserve local firebase authentication config
                    # The firebase section should never come from remote commands
                    old_config = shared_utils.read_config()
                    if old_config and 'firebase' in old_config:
                        new_config['firebase'] = old_config['firebase']
                        logging.debug("Preserved firebase section during update_config command")

                    shared_utils.write_json_to_file(new_config, shared_utils.CONFIG_PATH)
                    logging.info("Configuration updated from Firebase command")
                    return "Configuration updated successfully"
                else:
                    return "No configuration data provided"

            elif cmd_type == 'install_software':
                installer_url = cmd_data.get('installer_url')
                installer_name = cmd_data.get('installer_name', 'installer.exe')
                silent_flags = cmd_data.get('silent_flags', '')
                verify_path = cmd_data.get('verify_path')  # Optional — auto-derived from /DIR if absent
                timeout_seconds = cmd_data.get('timeout_seconds', 2400)  # Default: 40 minutes
                expected_sha256 = cmd_data.get('sha256_checksum')  # Optional but recommended
                deployment_id = cmd_data.get('deployment_id')  # For tracking deployment progress
                parallel_install = cmd_data.get('parallel_install', False)

                if not installer_url:
                    return "Error: No installer URL provided"

                # Auto-derive verify_path from /DIR flag if not explicitly provided
                if not verify_path and silent_flags:
                    dir_match = re.search(r'/DIR="([^"]+)"', silent_flags, re.IGNORECASE)
                    if not dir_match:
                        dir_match = re.search(r'/DIR=(\S+)', silent_flags, re.IGNORECASE)
                    if dir_match:
                        verify_path = dir_match.group(1)
                        logging.debug(f"Auto-derived verify_path from /DIR: {verify_path}")

                logging.info(f"Starting software installation: {installer_name}")
                logging.debug(f"URL: {installer_url}")
                logging.debug(f"Flags: {silent_flags}")
                logging.debug(f"Timeout: {timeout_seconds} seconds")
                if expected_sha256:
                    logging.debug(f"Checksum verification enabled: {expected_sha256[:16]}...")

                close_processes = cmd_data.get('close_processes', [])
                suppress_projects = cmd_data.get('suppress_projects', [])
                locked_project_ids = []

                if close_processes or suppress_projects:
                    locked_project_ids = self._terminate_processes_for_install(
                        close_processes, suppress_projects, deployment_id, cmd_id
                    )

                temp_installer_path = installer_utils.get_temp_installer_path(installer_name)

                try:
                    if self.firebase_client:
                        self.firebase_client.update_command_progress(cmd_id, 'downloading', deployment_id)

                    logging.debug(f"Downloading installer to: {temp_installer_path}")
                    download_success, actual_installer_path = installer_utils.download_file(installer_url, temp_installer_path)

                    if not download_success:
                        return f"Error: Failed to download installer from {installer_url}"

                    # Use the actual path where the file was saved (may differ if file was in use)
                    temp_installer_path = actual_installer_path

                    # Mandatory: without it a hijacked URL or a writable command doc
                    # ships arbitrary elevated code. The third-party install path
                    # used to skip this check.
                    if not expected_sha256:
                        installer_utils.cleanup_installer(temp_installer_path, force=True)
                        return (
                            f"Error: Refusing to install {installer_name} without "
                            f"sha256_checksum. Re-issue the command with a checksum."
                        )

                    logging.info("Verifying installer checksum...")
                    checksum_valid = installer_utils.verify_checksum(temp_installer_path, expected_sha256)
                    if not checksum_valid:
                        installer_utils.cleanup_installer(temp_installer_path, force=True)
                        return f"Error: Checksum verification failed for {installer_name}. Installation aborted for security."
                    logging.info("[OK] Checksum verification passed")

                    if self.firebase_client:
                        self.firebase_client.update_command_progress(cmd_id, 'installing', deployment_id)

                    # Session 0 has no desktop, so sub-installers (CodeMeter, VC++
                    # redists) hang there — run elevated in the user's session.
                    install_token, install_env = self._get_elevated_install_token()
                    if not install_token:
                        return "Error: No interactive user session available for installation. A user must be logged in."

                    # Hide existing registry keys so the installer can't detect and
                    # uninstall previous versions.
                    hidden_keys = []
                    if parallel_install:
                        # Registry-match name: "TouchDesigner.2025.32280.exe" →
                        # "TouchDesigner".
                        software_name = installer_name.split('.')[0] if '.' in installer_name else installer_name
                        logging.info(f"Parallel install enabled — hiding existing '{software_name}' registry keys")
                        hidden_keys = installer_utils.hide_registry_keys(software_name)

                    try:
                        logging.info("Executing installer with silent flags")
                        success, exit_code, error_msg = installer_utils.execute_installer(
                            temp_installer_path,
                            silent_flags,
                            installer_name,
                            self.active_installations,
                            timeout_seconds,
                            user_token=install_token,
                            environment=install_env,
                        )
                    finally:
                        # ALWAYS restore registry keys, even if installer fails
                        if hidden_keys:
                            logging.info("Restoring hidden registry keys")
                            installer_utils.restore_registry_keys(hidden_keys)

                    if not success:
                        return f"Error: Installation failed with exit code {exit_code}. {error_msg}"

                    if verify_path:
                        time.sleep(3)  # Allow filesystem to settle after install
                        if installer_utils.verify_installation(verify_path):
                            if exit_code == 3010:
                                result_msg = f"Installation completed successfully (reboot required). Verified at {verify_path}"
                            else:
                                result_msg = f"Installation completed successfully. Verified at {verify_path}"
                        else:
                            return f"Error: Installation completed (exit code {exit_code}) but verification failed - {verify_path} not found. The installer may have shown a dialog or requires different silent flags."
                    else:
                        if exit_code == 3010:
                            result_msg = f"Installation completed successfully (reboot required)"
                        else:
                            result_msg = f"Installation completed successfully (exit code {exit_code})"

                    logging.info(result_msg)

                    try:
                        if self.firebase_client and self.firebase_client.is_connected():
                            logging.info("Triggering software inventory sync after installation")
                            self.firebase_client.sync_software_inventory()
                    except Exception as sync_error:
                        logging.warning(f"Failed to sync software inventory after installation: {sync_error}")

                    return result_msg

                finally:
                    for project_id in locked_project_ids:
                        self.install_locks.pop(project_id, None)
                        logging.info(f"Released install lock for project {project_id}")
                    try:
                        installer_utils.cleanup_installer(temp_installer_path, force=True)
                    except Exception as cleanup_error:
                        logging.warning(f"Error in cleanup finally block: {cleanup_error}")

            elif cmd_type == 'update_owlette':
                return self._handle_update_owlette(cmd_id, cmd_data)

            elif cmd_type == 'cancel_installation':
                installer_name = cmd_data.get('installer_name')

                if not installer_name:
                    return "Error: No installer name provided for cancellation"

                logging.info(f"Cancellation requested for: {installer_name}")

                success, message = installer_utils.cancel_installation(
                    installer_name,
                    self.active_installations
                )

                if success:
                    logging.info(f"Installation cancelled: {installer_name}")
                    return f"Installation cancelled: {installer_name}"
                else:
                    logging.warning(f"Cancellation failed: {message}")
                    return f"Cancellation failed: {message}"

            elif cmd_type == 'uninstall_software':
                import registry_utils

                software_name = cmd_data.get('software_name')
                uninstall_command = cmd_data.get('uninstall_command')
                silent_flags = cmd_data.get('silent_flags', '')
                installer_type = cmd_data.get('installer_type', 'custom')
                verify_paths = cmd_data.get('verify_paths', [])  # Paths to verify removal
                timeout_seconds = cmd_data.get('timeout_seconds', 1200)  # Default: 20 minutes
                deployment_id = cmd_data.get('deployment_id')  # For tracking deployment progress

                if not software_name or not uninstall_command:
                    return "Error: Software name and uninstall command required"

                logging.info(f"Starting software uninstallation: {software_name}")
                logging.debug(f"Uninstall command: {uninstall_command}")
                logging.debug(f"Installer type: {installer_type}")
                logging.debug(f"Timeout: {timeout_seconds} seconds")

                if not silent_flags:
                    silent_flags = registry_utils.get_silent_uninstall_flags(installer_type)
                    logging.debug(f"Auto-detected silent flags: {silent_flags}")

                complete_command_str = registry_utils.build_silent_uninstall_command(
                    uninstall_command,
                    installer_type
                ) if not silent_flags else f"{uninstall_command} {silent_flags}"

                logging.debug(f"Complete uninstall command: {complete_command_str}")

                # posix=True strips the surrounding quotes from paths like
                # '"C:\Program Files\App\Uninstall.exe"'; leaving them makes
                # Popen fail with Access Denied.
                try:
                    complete_command = shlex.split(complete_command_str, posix=True)
                except ValueError as e:
                    return f"Error: Invalid uninstall command format: {e}"

                try:
                    if self.firebase_client:
                        self.firebase_client.update_command_progress(cmd_id, 'uninstalling', deployment_id)

                    logging.info("Executing uninstaller with silent flags")

                    # subprocess directly: execute_installer needs a file path and an
                    # uninstall has none.

                    uninstall_process_name = f"uninstall_{software_name.replace(' ', '_')}"

                    process = subprocess.Popen(
                        complete_command,
                        shell=False,
                        stdout=subprocess.PIPE,
                        stderr=subprocess.PIPE,
                        text=True
                    )

                    self.active_installations[uninstall_process_name] = process
                    logging.debug(f"Tracking uninstall process: {uninstall_process_name} (PID: {process.pid})")

                    try:
                        stdout, stderr = process.communicate(timeout=timeout_seconds)
                        exit_code = process.returncode
                    except subprocess.TimeoutExpired:
                        # Not identity-gated: this Popen handle is the
                        # uninstaller the service itself just spawned -- the
                        # handle, not a recyclable pid number, names the
                        # process, so the provenance is the spawn.
                        process.kill()
                        if uninstall_process_name in self.active_installations:
                            del self.active_installations[uninstall_process_name]
                        return f"Error: Uninstallation timeout (exceeded {timeout_seconds} seconds)"

                    if uninstall_process_name in self.active_installations:
                        del self.active_installations[uninstall_process_name]

                    logging.info(f"Uninstaller exit code: {exit_code}")

                    # Some uninstallers return non-zero even on success.
                    if exit_code not in [0, 3010]:  # 0 = success, 3010 = success but reboot required
                        logging.warning(f"Uninstaller returned exit code {exit_code}")
                        if stderr:
                            logging.error(f"Uninstaller stderr: {stderr}")

                    verification_results = []
                    if verify_paths:
                        for verify_path in verify_paths:
                            if verify_path:
                                path_exists = os.path.exists(verify_path)
                                verification_results.append({
                                    'path': verify_path,
                                    'removed': not path_exists
                                })
                                if path_exists:
                                    logging.warning(f"Verification: Path still exists after uninstall: {verify_path}")
                                else:
                                    logging.info(f"Verification: Path successfully removed: {verify_path}")

                    registry_check = registry_utils.search_software_by_name(software_name)
                    still_in_registry = len(registry_check) > 0

                    if still_in_registry:
                        logging.warning(f"Software still appears in registry after uninstall: {software_name}")
                        result_msg = f"Uninstall completed with exit code {exit_code}, but software still appears in registry (may require reboot)"
                    elif any(not vr['removed'] for vr in verification_results):
                        result_msg = f"Uninstall completed with exit code {exit_code}, but some files remain (may require reboot)"
                    else:
                        result_msg = f"Uninstall completed successfully (exit code {exit_code})"

                    logging.info(result_msg)

                    try:
                        if self.firebase_client and self.firebase_client.is_connected():
                            logging.info("Triggering software inventory sync after uninstall")
                            self.firebase_client.sync_software_inventory()
                    except Exception as sync_error:
                        logging.warning(f"Failed to sync software inventory after uninstall: {sync_error}")
                        # Don't fail the uninstall if sync fails

                    return result_msg

                except Exception as e:
                    error_msg = f"Unexpected error during uninstallation: {e}"
                    logging.error(error_msg)
                    logging.exception("Uninstall error details:")
                    return f"Error: {error_msg}"

            elif cmd_type == 'cancel_uninstall':
                software_name = cmd_data.get('software_name')

                if not software_name:
                    return "Error: No software name provided for cancellation"

                uninstall_process_name = f"uninstall_{software_name.replace(' ', '_')}"
                logging.info(f"Cancellation requested for: {uninstall_process_name}")

                success, message = installer_utils.cancel_installation(
                    uninstall_process_name,
                    self.active_installations
                )

                if success:
                    logging.info(f"Uninstallation cancelled: {software_name}")
                    return f"Uninstallation cancelled: {software_name}"
                else:
                    logging.warning(f"Cancellation failed: {message}")
                    return f"Cancellation failed: {message}"

            elif cmd_type == 'refresh_software_inventory':
                logging.info("Refreshing software inventory on demand")
                try:
                    if self.firebase_client and self.firebase_client.is_connected():
                        self.firebase_client._sync_software_inventory(force=True)
                        return "Software inventory refreshed successfully"
                    else:
                        return "Error: Not connected to Firebase"
                except Exception as e:
                    error_msg = f"Failed to refresh software inventory: {str(e)}"
                    logging.error(error_msg)
                    return error_msg

            elif cmd_type == 'mcp_tool_call':
                tool_name = cmd_data.get('tool_name')
                tool_params = cmd_data.get('tool_params', {})

                if not tool_name:
                    return "Error: No tool_name provided for mcp_tool_call"

                logging.info(f"Executing MCP tool: {tool_name} with params: {list(tool_params.keys())}")

                # Tools that need user-session execution (desktop access)
                import json as _json
                user_session_result = self._try_user_session_tool(tool_name, tool_params)
                if user_session_result is not None:
                    self._log_cortex_tool(tool_name, tool_params, user_session_result)
                    return _json.dumps(user_session_result)

                import mcp_tools
                config = shared_utils.read_config()
                # command_id lets execute_script register its subprocess so
                # cancel_mcp_tool can reach it.
                result = mcp_tools.execute_tool(tool_name, tool_params, config, command_id=cmd_id)

                self._log_cortex_tool(tool_name, tool_params, result)

                # Firestore + the dashboard both want a string, not the dict.
                return _json.dumps(result)

            elif cmd_type == 'reboot_machine':
                return self._handle_reboot_machine(cmd_data)

            elif cmd_type == 'shutdown_machine':
                return self._handle_shutdown_machine(cmd_data)

            elif cmd_type == 'cancel_reboot':
                return self._handle_cancel_reboot(cmd_data)

            elif cmd_type == 'dismiss_reboot_pending':
                return self._handle_dismiss_reboot_pending(cmd_data)

            elif cmd_type == 'provision_cortex_key':
                return self._handle_provision_cortex_key(cmd_data)

            elif cmd_type == 'start_live_view':
                return self._handle_start_live_view(cmd_data)

            elif cmd_type == 'stop_live_view':
                return self._handle_stop_live_view(cmd_data)

            elif cmd_type == 'apply_display_topology':
                # validate → snapshot → apply, synchronously, arming a revert
                # watchdog before returning: without an ack_display_topology
                # inside the deadline the config auto-reverts. `applyId` threads
                # through so a stale ack can't cancel this apply.
                layout = cmd_data.get('layout')
                apply_id = cmd_data.get('applyId') or cmd_data.get('apply_id')
                try:
                    import display_manager

                    result = display_manager.apply_topology(
                        layout,
                        firebase_client=self.firebase_client,
                        apply_id=apply_id,
                    )
                    if isinstance(result, dict) and result.get('success'):
                        change_count = len(result.get('changes', []) or [])
                        revert_s = result.get('revertDeadlineSeconds', 0)
                        return (
                            f"Display topology applied — {change_count} changes, "
                            f"revert in {revert_s}s"
                        )
                    return _display_error_result(result)
                except Exception as e:
                    return f"Error: {e}"

            elif cmd_type == 'enumerate_display_modes':
                # Uploads the supported-modes catalogue to
                # machines/{id}/hardware/displayModes, skipping when signatureHash
                # is unchanged so the dashboard's editor-open dispatch is a no-op
                # on repeat visits.
                try:
                    result = self.firebase_client._ensure_display_modes_catalogue()
                    if isinstance(result, dict) and result.get('ok'):
                        mc = result.get('monitorCount', 0)
                        mk = result.get('modeCount', 0)
                        if result.get('uploaded'):
                            return (
                                f"Uploaded catalogue — {mk} modes "
                                f"across {mc} monitors"
                            )
                        reason = result.get('reason') or 'unknown'
                        return (
                            f"Enumerated {mk} modes across {mc} monitors "
                            f"(skipped upload: {reason})"
                        )
                    code = (
                        result.get('code', 'unknown')
                        if isinstance(result, dict) else 'unknown'
                    )
                    err = (
                        result.get('error', 'unknown')
                        if isinstance(result, dict) else str(result)
                    )
                    return f"Error: {code} {err}"
                except Exception as e:
                    return f"Error: {e}"

            elif cmd_type == 'ack_display_topology':
                # Cancels the auto-revert watchdog. Past the revert deadline it's
                # a no-op against an already-reverted config; a mismatched
                # `applyId` is rejected.
                apply_id = cmd_data.get('applyId') or cmd_data.get('apply_id')
                try:
                    import display_manager

                    result = display_manager.ack_apply(
                        apply_id=apply_id, firebase_client=self.firebase_client,
                    )
                    if isinstance(result, dict) and result.get('success'):
                        return result.get('message', 'apply acknowledged')
                    err = (
                        result.get('error', 'unknown')
                        if isinstance(result, dict) else str(result)
                    )
                    return f"Error: {err}"
                except Exception as e:
                    return f"Error: {e}"

            elif cmd_type == 'test_display_apply':
                # Read-only IPC smoke test: query + SDC_VALIDATE in the console
                # session, never SDC_APPLY. Lets an operator verify the plumbing
                # before enabling `displays.remoteApplyEnabled`, so it bypasses
                # the apply kill switch.
                try:
                    import display_manager

                    result = display_manager._self_test_via_user_session()
                    if isinstance(result, dict) and result.get('ok'):
                        seen = result.get('monitors_seen', 0)
                        q = result.get('query_ms', 0)
                        v = result.get('validate_ms', 0)
                        return (
                            f"Self-test ok — {seen} monitors, "
                            f"query {q}ms, validate {v}ms"
                        )
                    return _display_error_result(result)
                except Exception as e:
                    return f"Error: {e}"

            else:
                logging.warning(f"Unknown command type: {cmd_type}")
                return f"Unknown command type: {cmd_type}"

        except Exception as e:
            # The "Error:" prefix is load-bearing: _execute_command writes
            # status:'failed' only for results starting with it. Dropping the
            # colon recorded failures in firestore as completed commands.
            error_msg = f"Error: executing command {cmd_type}: {e}"
            logging.error(error_msg, exc_info=True)
            return error_msg

    def _check_display_topology(self):
        """Snapshot the current display topology and log changes.

        Gated by the ``displays.enabled`` config kill switch. Runs the CCD
        enumeration under a 5s watchdog (defence-in-depth — display_manager
        already wraps its own query with a shorter timeout). Merges Mosaic /
        GSync data from NVAPI into the profile dict and compares the resulting
        signature hash to the cached value. Firestore upload of the profile
        happens in firebase_client's metrics loop (Task 2.2), so nothing is
        dispatched from here.

        Also drives the Wave 5 deferred-revert retry: if startup found a
        sentinel but no console user was logged in, this tick re-checks for
        a console session and re-runs ``apply_revert_from_sentinel`` once one
        appears. Runs before the kill switch so a pending recovery hook
        finishes even if the operator toggled ``displays.enabled`` off after
        the original apply.
        """
        # Ahead of the imports, not behind the kill switch with everything
        # else: display_manager is Windows-only and never ported, and the
        # import alone would log a warning on every tick that no switch here
        # can silence.
        if sys.platform != 'win32':
            return

        try:
            import display_manager
            import nvapi_display
            import win32ts

            # Retry a deferred startup revert once a console session appears;
            # both probes are cheap.
            if getattr(display_manager, '_deferred_revert_pending', False):
                try:
                    console_session = win32ts.WTSGetActiveConsoleSessionId()
                except Exception as e:
                    logging.debug(f"WTSGetActiveConsoleSessionId failed during deferred-revert probe: {e}")
                    console_session = 0xFFFFFFFF
                if console_session != 0xFFFFFFFF:
                    logging.info(
                        f"Console session {console_session} now available — "
                        "retrying deferred display revert"
                    )
                    try:
                        result = display_manager.apply_revert_from_sentinel(
                            firebase_client=self.firebase_client,
                        )
                        logging.info(f"Deferred display revert retry: {result}")
                    except Exception as revert_err:
                        logging.error(f"Deferred display revert retry failed: {revert_err}")

            # Only an explicit False disables — installs with no `displays`
            # block must keep collecting topology.
            if shared_utils.read_config(['displays', 'enabled']) is False:
                return

            # Manual lifecycle, not `with`: shutdown(wait=True) on block exit held
            # the 5s MAIN LOOP for the worker's full duration, so the advertised
            # 5s bound was never actually enforced. Blocking this loop is a named
            # landmine — it stalls every monitor on the machine. The `return`s in
            # the handlers below still run the finally; that is the point.
            pool = ThreadPoolExecutor(max_workers=1)
            try:
                future = pool.submit(display_manager.build_display_profile)
                profile = future.result(timeout=5)
            except FuturesTimeoutError:
                logging.warning("Display topology enumeration timed out after 5s")
                return
            except Exception as e:
                logging.warning(f"Display topology enumeration failed: {e}")
                return
            finally:
                pool.shutdown(wait=False, cancel_futures=True)

            if not isinstance(profile, dict):
                logging.debug("Display topology returned non-dict payload, skipping")
                return

            # A FAILED enumeration is not a topology. build_display_profile
            # returns `monitors: []` + `enumerationFailed: True` when CCD could
            # not be read, and display_signature() hashes only the monitor list —
            # so that placeholder is byte-identical to "every display genuinely
            # went away". Without this gate the code below diffs the last good
            # profile against [] and emits one CRITICAL `display_monitor_removed`
            # per monitor, naming panels that are still plugged in, and the
            # routing table sends those immediately rather than digesting them.
            #
            # It also CACHED the placeholder, so the next successful enumeration
            # diffed against [] and emitted `display_monitor_added` for every
            # monitor — a phantom remove/add flap per failure.
            #
            # The other three consumers of this flag already refuse the
            # placeholder (firebase_client.py:1248 and :1426 skip the uploads to
            # avoid clobbering good Firestore data; the auto-restore check below
            # skips too). The alerting path was the one that did not, which is
            # why the dashboard kept showing the monitors present while the email
            # said they had been removed.
            if profile.get('enumerationFailed') is True:
                logging.warning(
                    "Display enumeration failed; skipping topology comparison "
                    "(no events emitted, cache left intact)"
                )
                # Still hand the failure to the drift tracker before returning.
                # Its own gate does NOT merely return — it RESETS
                # `_drift_pending_tick_count` and `_drift_pending_key`, so a
                # failed enumeration is what breaks the auto-restore debounce
                # streak. Returning past it would let a streak survive across
                # failures on a machine whose enumeration is flaky, and fire an
                # unattended apply_topology — a physical display re-apply — that
                # the reset had been suppressing. That is the opposite of what
                # this gate is for: those are the very machines already having
                # display trouble.
                try:
                    self._maybe_auto_restore_assigned_drift(profile)
                except Exception as e:
                    logging.debug(f"auto-restore drift reset failed: {e}")
                return

            # Merge NVAPI Mosaic / GSync data (best-effort — None on non-NVIDIA).
            try:
                mosaic = nvapi_display.detect_mosaic()
            except Exception as e:
                logging.debug(f"detect_mosaic raised: {e}")
                mosaic = None
            if mosaic is not None:
                profile['mosaicActive'] = True
                profile['mosaicGrids'] = mosaic.get('grids', [])

            try:
                sync = nvapi_display.detect_sync()
            except Exception as e:
                logging.debug(f"detect_sync raised: {e}")
                sync = None
            if sync is not None:
                profile['syncDevices'] = sync.get('devices', [])

            # Re-hash after merging so the signature reflects Mosaic state.
            try:
                profile['signatureHash'] = display_manager.display_signature(profile)
            except Exception as e:
                logging.debug(f"display_signature rehash failed: {e}")

            new_hash = profile.get('signatureHash') or ''
            if new_hash and new_hash != self._cached_display_hash:
                prev_profile = self._cached_display_profile
                if self._cached_display_hash is None:
                    logging.info(f"Display topology baseline: {new_hash} ({len(profile.get('monitors') or [])} monitor(s))")
                else:
                    logging.info(
                        f"Display topology changed: {self._cached_display_hash} -> {new_hash} "
                        f"({len(profile.get('monitors') or [])} monitor(s))"
                    )
                self._cached_display_hash = new_hash
                self._cached_display_profile = profile
                # Push now instead of waiting up to 5 min for the metrics tick:
                # the rate-limit gate is for no-op rebuilds, not real changes.
                if self.firebase_client:
                    try:
                        self.firebase_client._ensure_display_profile(force=True)
                    except Exception as e:
                        logging.debug(f"Forced display profile upload failed: {e}")
                # One event per symptom; skipped on first run. Isolated so a
                # logging failure can't break the upload path above.
                if prev_profile is not None and self.firebase_client:
                    try:
                        self._emit_display_change_events(prev_profile, profile)
                    except Exception as e:
                        logging.debug(f"Display change event emission failed: {e}")

            # Live-vs-assigned, not live-vs-previous: runs every check so stable
            # drift is still corrected once the signature stops changing.
            try:
                self._maybe_auto_restore_assigned_drift(profile)
            except Exception as e:
                logging.debug(f"Assigned-drift auto-restore check failed: {e}")
        except Exception as e:
            logging.warning(f"Display topology check failed: {e}")

    # Labels MUST match computeDisplayDrift in web/hooks/useDisplayState.ts so
    # dashboard and agent describe drift identically.
    _DISPLAY_DRIFT_FIELDS = (
        ('position.x',        lambda m: (m.get('position') or {}).get('x')),
        ('position.y',        lambda m: (m.get('position') or {}).get('y')),
        ('resolution.width',  lambda m: (m.get('resolution') or {}).get('width')),
        ('resolution.height', lambda m: (m.get('resolution') or {}).get('height')),
        ('refreshHz',         lambda m: m.get('refreshHz')),
        ('rotation',          lambda m: m.get('rotation')),
        ('scalePct',          lambda m: m.get('scalePct')),
        ('primary',           lambda m: m.get('primary')),
    )

    # Only fields the CCD apply path can enforce. `scalePct` is excluded —
    # apply_topology can't change DPI scale, so scale-only drift would flash the
    # displays forever without converging.
    _AUTO_RESTORE_DRIFT_FIELDS = (
        ('position.x',        lambda m: (m.get('position') or {}).get('x')),
        ('position.y',        lambda m: (m.get('position') or {}).get('y')),
        ('resolution.width',  lambda m: (m.get('resolution') or {}).get('width')),
        ('resolution.height', lambda m: (m.get('resolution') or {}).get('height')),
        ('refreshHz',         lambda m: m.get('refreshHz')),
        ('rotation',          lambda m: m.get('rotation')),
        ('primary',           lambda m: m.get('primary')),
    )
    _AUTO_RESTORE_REFRESH_TOLERANCE_HZ = 0.01

    @staticmethod
    def _display_monitor_summary(monitor: dict) -> dict:
        """Compact monitor descriptor embedded in each display_* event payload."""
        return {
            'edidHash': monitor.get('edidHash') or '',
            'friendlyName': monitor.get('friendlyName') or '',
            'port': monitor.get('connectionType') or '',
        }

    def _emit_display_event(self, event_type: str, severity: str, payload: dict):
        """Emit a single categorized display event via the firebase_client
        log_event helper. ``payload`` is JSON-serialized into ``details`` so
        structured fields (monitor, changes) survive the flat log schema.

        log_event already stamps machineId + timestamp (SERVER_TIMESTAMP), so
        we don't duplicate those here.

        The same ``payload`` is handed to ``send_display_alert``, which posts
        it to ``/api/agent/alert`` for email + webhook delivery. Two distinct
        sinks: the log write owns the dashboard feed and the talon bridge, the
        alert owns out-of-band delivery — neither substitutes for the other.
        ``send_display_alert`` is non-blocking (daemon thread + retry queue)
        and drops event types with no routing entry itself, so callers hand it
        every event unconditionally.

        ``payload`` carries the ``suppressAlert`` / ``correlatedApplyId`` flags
        stamped by ``_emit_display_change_events`` when the event lands inside
        the post-apply suppression window; the routing endpoint reads them off
        ``data`` to skip email while still firing the webhook.
        """
        try:
            details = json.dumps(payload, separators=(',', ':'), sort_keys=True)
        except (TypeError, ValueError) as e:
            logging.debug(f"Failed to serialize {event_type} payload: {e}")
            return
        self.firebase_client.log_event(
            action=event_type,
            level=severity,
            details=details,
        )
        self.firebase_client.send_display_alert(event_type, payload)

    @staticmethod
    def _auto_restore_values_equal(label: str, live_value, assigned_value) -> bool:
        if label == 'refreshHz':
            try:
                return (
                    abs(float(live_value) - float(assigned_value))
                    <= OwletteService._AUTO_RESTORE_REFRESH_TOLERANCE_HZ
                )
            except (TypeError, ValueError):
                return live_value == assigned_value
        return live_value == assigned_value

    @staticmethod
    def _auto_restore_field_is_enforceable(label: str, assigned_monitor: dict) -> bool:
        if not isinstance(assigned_monitor, dict):
            return False
        if label.startswith('position.'):
            position = assigned_monitor.get('position')
            axis = label.split('.', 1)[1]
            return (
                isinstance(position, dict)
                and isinstance(position.get(axis), (int, float))
            )
        if label.startswith('resolution.'):
            resolution = assigned_monitor.get('resolution')
            axis = label.split('.', 1)[1]
            return (
                isinstance(resolution, dict)
                and isinstance(resolution.get(axis), (int, float))
                and resolution.get(axis) > 0
            )
        if label == 'refreshHz':
            refresh = assigned_monitor.get('refreshHz')
            return isinstance(refresh, (int, float)) and refresh > 0
        if label == 'rotation':
            return assigned_monitor.get('rotation') is not None
        if label == 'primary':
            return isinstance(assigned_monitor.get('primary'), bool)
        return False

    @staticmethod
    def _auto_restore_key_value(label: str, value):
        try:
            if label == 'refreshHz':
                return round(float(value), 2)
            if label in (
                'position.x', 'position.y',
                'resolution.width', 'resolution.height',
                'rotation',
            ):
                return int(value)
        except (TypeError, ValueError):
            return value
        return value

    def _assigned_drift_details(self, profile: dict, assigned_layout: dict) -> list:
        """Return restorable live-vs-assigned drift details keyed by edidHash.

        This mirrors the dashboard/heartbeat drift model: match physical
        monitors by edidHash and ignore added/removed monitors because
        re-applying the stored layout cannot safely fix topology membership
        changes. Unlike the dashboard, this intentionally ignores fields the
        apply path cannot enforce.
        """
        import display_manager

        live_monitors = (
            profile.get('monitors') if isinstance(profile, dict) else None
        ) or []
        assigned_monitors = (
            assigned_layout.get('monitors')
            if isinstance(assigned_layout, dict) else None
        ) or []
        # Re-derived from raw identity fields so layouts saved under the old
        # (friendly-name inclusive) hashing still match by physical identity.
        assigned_monitors = display_manager.canonicalize_monitor_hashes(
            assigned_monitors,
        )
        assigned_by_hash = {
            m.get('edidHash'): m for m in assigned_monitors
            if m.get('edidHash')
        }
        if not assigned_by_hash:
            return []

        drifted = []
        for live_monitor in live_monitors:
            if not isinstance(live_monitor, dict):
                continue
            edid_hash = live_monitor.get('edidHash')
            assigned_monitor = assigned_by_hash.get(edid_hash)
            if not edid_hash or assigned_monitor is None:
                continue
            changes = []
            for label, extract in self._AUTO_RESTORE_DRIFT_FIELDS:
                if not self._auto_restore_field_is_enforceable(
                    label, assigned_monitor,
                ):
                    continue
                live_value = extract(live_monitor)
                assigned_value = extract(assigned_monitor)
                if not self._auto_restore_values_equal(
                    label, live_value, assigned_value
                ):
                    changes.append({
                        'field': label,
                        'live': self._auto_restore_key_value(label, live_value),
                        'assigned': self._auto_restore_key_value(
                            label, assigned_value,
                        ),
                    })
            if changes:
                drifted.append({'edidHash': edid_hash, 'changes': changes})
        return drifted

    def _assigned_drift_hashes(self, profile: dict, assigned_layout: dict) -> list:
        """Return edidHashes whose live monitor state has restorable drift."""
        return [
            item.get('edidHash') for item in self._assigned_drift_details(
                profile, assigned_layout,
            )
            if item.get('edidHash')
        ]

    @staticmethod
    def _assigned_drift_key(drift_details: list) -> str:
        """Stable key for a specific live-vs-assigned drift shape."""
        normalized = []
        for item in drift_details:
            if not isinstance(item, dict) or not item.get('edidHash'):
                continue
            changes = item.get('changes') or []
            normalized.append({
                'edidHash': item.get('edidHash'),
                'changes': sorted(
                    [
                        {
                            'field': c.get('field'),
                            'live': c.get('live'),
                            'assigned': c.get('assigned'),
                        }
                        for c in changes if isinstance(c, dict)
                    ],
                    key=lambda c: str(c.get('field') or ''),
                ),
            })
        normalized.sort(key=lambda item: str(item.get('edidHash') or ''))
        return json.dumps(normalized, separators=(',', ':'), sort_keys=True)

    def _maybe_auto_restore_assigned_drift(self, profile: dict):
        """Evaluate live-vs-assigned drift every display-check tick.

        Display change events only fire when the live topology signature
        changes. Auto-restore must also catch stable drift, so this method
        maintains the persistence counter from the current live profile
        against the stored layout and then enters the normal gate chain.
        """
        if isinstance(profile, dict) and profile.get('enumerationFailed') is True:
            self._drift_pending_tick_count = 0
            self._drift_pending_key = None
            return

        try:
            assigned_layout = shared_utils.read_config(['displays', 'assigned'])
        except Exception as e:
            logging.debug(f"auto-restore: read assigned layout failed: {e}")
            self._drift_pending_tick_count = 0
            self._drift_pending_key = None
            return

        drift_details = self._assigned_drift_details(profile, assigned_layout)
        if not drift_details:
            self._drift_pending_tick_count = 0
            self._drift_pending_key = None
            self._last_auto_restore_success_key = None
            return

        drift_key = self._assigned_drift_key(drift_details)
        if drift_key != getattr(self, '_drift_pending_key', None):
            self._drift_pending_key = drift_key
            self._drift_pending_tick_count = 1
        else:
            self._drift_pending_tick_count += 1

        if drift_key == getattr(self, '_last_auto_restore_success_key', None):
            return

        drifted_hashes = [
            item.get('edidHash') for item in drift_details
            if item.get('edidHash')
        ]
        self._maybe_auto_restore(
            profile, drifted_hashes, drift_key, assigned_layout,
        )

    def _emit_display_change_events(self, prev_profile: dict, new_profile: dict):
        """Diff two display profiles and emit one log event per distinct
        change category. Called only when the topology signature actually
        changed, so at least one event is expected (modulo edge cases where
        only unhashed fields flipped, which is fine — no events emitted).
        """
        import display_manager

        prev_monitors = prev_profile.get('monitors') or []
        new_monitors = new_profile.get('monitors') or []

        # Merged into every event below. `signatureHash` lets receivers dedupe a
        # single topology change; `assignedLayoutId` is reserved and stays an
        # empty string so the field is JSON-stable.
        base_payload = {
            'signatureHash': new_profile.get('signatureHash') or '',
            'monitorCount': len(new_monitors),
            'assignedLayoutId': '',
            # Forwarded so the claim stays falsifiable: without it, "the agent
            # looked and the monitor was gone" and "the agent could not look at
            # all" arrive downstream as the same critical alert, and no consumer
            # can tell them apart. The caller now gates on this flag, so it
            # should always be False here — it is carried for defence in depth.
            'enumerationFailed': bool(new_profile.get('enumerationFailed', False)),
        }

        # Inside the post-apply window, stamp `suppressAlert` plus the causing
        # apply so the routing endpoint can correlate. Predicate lives in
        # display_manager so it stays testable on its own.
        try:
            if display_manager.is_within_apply_suppression_window():
                base_payload['suppressAlert'] = True
                base_payload['correlatedApplyId'] = (
                    display_manager._current_apply_id or ''
                )
        except Exception as e:  # pragma: no cover — defensive
            logging.debug(f"display suppression check raised: {e}")

        # Identity diffing by edidHash. Monitors lacking one (broken EDID,
        # generic driver) can't be categorised; the signature hash already
        # caught the transition.
        prev_by_hash = {m.get('edidHash'): m for m in prev_monitors if m.get('edidHash')}
        new_by_hash = {m.get('edidHash'): m for m in new_monitors if m.get('edidHash')}

        # 1. Added monitors — new edidHash not present previously.
        for edid_hash, monitor in new_by_hash.items():
            if edid_hash not in prev_by_hash:
                self._emit_display_event('display_monitor_added', 'info', {
                    **base_payload,
                    'monitor': self._display_monitor_summary(monitor),
                })

        # 2. Removed monitors — previously present edidHash now gone.
        for edid_hash, monitor in prev_by_hash.items():
            if edid_hash not in new_by_hash:
                self._emit_display_event('display_monitor_removed', 'critical', {
                    **base_payload,
                    'monitor': self._display_monitor_summary(monitor),
                })

        # Swap = same targetId, different EDID (cable moved on one output).
        # Keyed on targetId because edidHash identifies the panel, not the port.
        prev_by_target = {
            m.get('targetId'): m for m in prev_monitors
            if m.get('targetId') is not None and m.get('edidHash')
        }
        for new_monitor in new_monitors:
            target_id = new_monitor.get('targetId')
            new_hash = new_monitor.get('edidHash')
            if target_id is None or not new_hash:
                continue
            prev_monitor = prev_by_target.get(target_id)
            if prev_monitor and prev_monitor.get('edidHash') != new_hash:
                self._emit_display_event('display_monitor_swapped', 'warning', {
                    **base_payload,
                    'monitor': self._display_monitor_summary(new_monitor),
                    'previousEdidHash': prev_monitor.get('edidHash') or '',
                })

        # Drift: same edidHash, tracked fields changed. One event per monitor,
        # not bundled. Hashes are collected for gate 5 below, which requires
        # every drifted monitor to exist in the assigned layout.
        drifted_hashes: list = []
        for edid_hash, new_monitor in new_by_hash.items():
            prev_monitor = prev_by_hash.get(edid_hash)
            if prev_monitor is None:
                continue
            changes = [
                label for label, extract in self._DISPLAY_DRIFT_FIELDS
                if extract(prev_monitor) != extract(new_monitor)
            ]
            if changes:
                self._emit_display_event('display_drift', 'warning', {
                    **base_payload,
                    'monitor': self._display_monitor_summary(new_monitor),
                    'changes': changes,
                })
                drifted_hashes.append(edid_hash)

        # 5. Mosaic disabled — grid active previously, not active now.
        prev_mosaic = bool(prev_profile.get('mosaicActive'))
        new_mosaic = bool(new_profile.get('mosaicActive'))
        if prev_mosaic and not new_mosaic:
            self._emit_display_event('display_mosaic_disabled', 'warning', {
                **base_payload,
            })

        # Sync lost: a locked device is no longer locked. Matched by deviceId so
        # reordering syncDevices isn't a false positive.
        prev_sync = prev_profile.get('syncDevices') or []
        new_sync = new_profile.get('syncDevices') or []
        new_sync_by_id = {d.get('deviceId'): d for d in new_sync if d.get('deviceId')}
        new_sync_fallback = new_sync  # used when deviceId is missing
        for idx, prev_device in enumerate(prev_sync):
            if not prev_device.get('locked'):
                continue
            device_id = prev_device.get('deviceId')
            if device_id and device_id in new_sync_by_id:
                new_device = new_sync_by_id[device_id]
            elif not device_id and idx < len(new_sync_fallback):
                new_device = new_sync_fallback[idx]
            else:
                new_device = None
            if new_device is None or not new_device.get('locked'):
                self._emit_display_event('display_sync_lost', 'warning', {
                    **base_payload,
                    'deviceId': device_id or '',
                })

    def _maybe_auto_restore(
        self, new_profile: dict, drifted_hashes: list, drift_key: str = None,
        assigned_layout: dict = None,
    ):
        """Gate chain + dispatch for unattended drift-correction apply (C2.1).

        Called from the assigned-drift checker after restorable drift has
        persisted. Walks 7 gates in order; on first failure, returns without
        spawning the worker. On all-pass, spawns ``_run_auto_restore`` on a
        daemon thread (off-loop so the apply call never stalls process
        monitoring).
        """
        import display_manager

        # Gate 1: kill switch — displays feature must not be explicitly disabled.
        try:
            if shared_utils.read_config(['displays', 'enabled']) is False:
                return
        except Exception as e:
            logging.debug(f"auto-restore gate 1 (displays.enabled) read failed: {e}")
            return

        # Gate 2: opt-in — autoRestore must be explicitly enabled per machine.
        try:
            if shared_utils.read_config(['displays', 'autoRestore', 'enabled']) is not True:
                return
        except Exception as e:
            logging.debug(f"auto-restore gate 2 (autoRestore.enabled) read failed: {e}")
            return

        # Gate 3: circuit breaker. Operator resets it from the dashboard; the
        # value arrives on the next config sync tick.
        try:
            if shared_utils.read_config(
                ['displays', 'autoRestore', 'circuitBreaker', 'tripped']
            ) is True:
                return
        except Exception as e:
            logging.debug(f"auto-restore gate 3 (breaker.tripped) read failed: {e}")
            return

        # Gate 4: no manual apply in flight — never race against an operator.
        if display_manager._apply_in_flight:
            return

        # Gate 5: a drifted monitor missing from the assigned layout (usually a
        # newly added one) can't be fixed by re-applying — audit and return.
        if assigned_layout is None:
            try:
                assigned_layout = shared_utils.read_config(['displays', 'assigned'])
            except Exception as e:
                logging.debug(f"auto-restore: read assigned layout failed: {e}")
                return
        if not isinstance(assigned_layout, dict):
            return
        assigned_monitors = display_manager.canonicalize_monitor_hashes(
            assigned_layout.get('monitors') or [],
        )
        assigned_hashes = {
            m.get('edidHash') for m in assigned_monitors if m.get('edidHash')
        }
        missing = [h for h in drifted_hashes if h not in assigned_hashes]
        if missing:
            self._emit_display_event('display_auto_restore_skipped_unfixable', 'info', {
                'eventType': 'display_auto_restore_skipped_unfixable',
                'severity': 'info',
                'reason': 'unfixable',
                'missingFromAssigned': missing,
            })
            return

        # Gate 5b: an assigned monitor that is powered off can never be applied
        # (apply_topology returns MISSING_MONITORS pre-SetDisplayConfig), and
        # retrying every tick emits a `display_apply_failed` audit each time.
        # `display_monitor_removed` already records the absence, so skip
        # silently; drift is re-evaluated once the monitor returns.
        live_hashes = {
            m.get('edidHash')
            for m in (new_profile.get('monitors') or [])
            if isinstance(m, dict) and m.get('edidHash')
        }
        if any(h not in live_hashes for h in assigned_hashes):
            return

        # Gate 6: >= 2 consecutive drift ticks, so a cable wiggle can't fire it.
        if self._drift_pending_tick_count < 2:
            return

        # Gate 7: cooldown — never fire inside the apply_topology rate-limit window.
        if (time.time() - display_manager._last_apply_time
                < display_manager._APPLY_COOLDOWN_SECONDS):
            return

        t = threading.Thread(
            target=self._run_auto_restore,
            args=(assigned_layout, drift_key),
            daemon=True,
            name='display-auto-restore',
        )
        t.start()

    @staticmethod
    def _auto_restore_apply_was_skip(result: dict) -> bool:
        import display_manager

        code = result.get('code') if isinstance(result, dict) else None
        if code in (
            display_manager.DisplayErrorCode.AUTO_RESTORE_RATE_LIMITED,
            display_manager.DisplayErrorCode.AUTO_RESTORE_SKIPPED_UNFIXABLE,
            # A pre-apply skip, not a failure: counting MISSING_MONITORS tripped
            # the sticky breaker after 3 ticks of a routine monitor power-off and
            # paused auto-restore until a manual reset.
            display_manager.DisplayErrorCode.MISSING_MONITORS,
        ):
            return True
        error_text = str((result or {}).get('error') or '').strip().lower()
        return (
            error_text == 'apply already in progress'
            or error_text.startswith('rate limited')
        )

    def _run_auto_restore(self, assigned_layout: dict, drift_key: str = None):
        """Daemon worker: invoke apply_topology(auto_restore=True) and update
        circuit-breaker state in Firestore based on the result. Never raises
        — always logs + swallows so a stray exception can't kill the thread
        without trace.
        """
        import display_manager

        try:
            import uuid
            apply_id = uuid.uuid4().hex
            result = display_manager.apply_topology(
                assigned_layout,
                firebase_client=self.firebase_client,
                auto_restore=True,
                apply_id=apply_id,
            )

            now_iso = datetime.datetime.now(datetime.timezone.utc).isoformat()

            if result.get('success'):
                # Reset on every success, so an old isolated failure can't leave a
                # counter that trips on the next one.
                self.firebase_client.update_display_autorestore_state({
                    'failures': 0,
                    'tripped': False,
                    'lastSuccessAt': now_iso,
                })
                if drift_key:
                    self._last_auto_restore_success_key = drift_key
                return

            # Pre-apply skips from apply_topology, not failures — don't count
            # them toward the breaker.
            if self._auto_restore_apply_was_skip(result):
                return

            # Real failure: read the Firestore-synced local value and bump it.
            try:
                current_failures = shared_utils.read_config(
                    ['displays', 'autoRestore', 'circuitBreaker', 'failures']
                )
            except Exception:
                current_failures = 0
            if not isinstance(current_failures, int) or current_failures < 0:
                current_failures = 0
            new_failures = current_failures + 1

            error_str = str(result.get('error') or 'unknown error')[:500]
            patch = {
                'failures': new_failures,
                'lastFailureAt': now_iso,
                'lastError': error_str,
            }
            if new_failures >= 3:
                patch['tripped'] = True
                patch['trippedAt'] = now_iso
            self.firebase_client.update_display_autorestore_state(patch)

            if new_failures >= 3:
                self._emit_display_event(
                    'display_auto_restore_circuit_breaker_tripped',
                    'error',
                    {
                        'eventType': 'display_auto_restore_circuit_breaker_tripped',
                        'severity': 'error',
                        'failures': new_failures,
                        'lastError': error_str,
                    },
                )
        except Exception as e:
            logging.warning(f"_run_auto_restore failed: {e}")

    def _maybe_dispatch_roost_scrub(self):
        """Run roost scrub + content-store reap on a daemon thread if idle.

        Called from the main loop every ROOST_SCRUB_CHECK_ITERATIONS. Single-flight:
        if a previous scrub thread is still alive, this iteration is a no-op.
        Both jobs run off-loop so a long re-hash never stalls process monitoring.

        The reap runs after the scrub and independently of it: it collects
        cached chunks that no in-flight distribution references and that are
        older than the reaper's age threshold, which is what stops a failed
        distribution's downloaded bytes from sitting on disk forever.
        """
        if self._roost_scrub_thread is not None and self._roost_scrub_thread.is_alive():
            return

        def _run_scrub():
            try:
                from sync_commands import _state_for
                from sync_scrub import scrub_all_due
                state = _state_for(self)
                report_dir = shared_utils.get_data_path('logs/roost_scrub_reports')
                reports = scrub_all_due(state, report_dir=report_dir)
                if reports:
                    drifted = sum(1 for r in reports if not r.healthy)
                    logging.info(
                        f"roost scrub: {len(reports)} distribution(s) scrubbed, "
                        f"{drifted} with drift"
                    )
            except Exception as e:
                # exc_info so a schema mismatch surfaces its stack.
                logging.warning(f"roost scrub failed: {e}", exc_info=True)

            # Separate try: scrub and reap share only the state DB handle, so one
            # failing must not skip the other.
            try:
                from sync_commands import _state_for
                from sync_scrub import reap_orphan_chunks
                report = reap_orphan_chunks(_state_for(self))
                if report.deleted or report.failed:
                    logging.info(
                        f"roost content-store reap: deleted {report.deleted} orphan "
                        f"chunk(s), {report.bytes_freed / (1024 * 1024):.1f} MiB freed, "
                        f"{report.failed} failed"
                    )
            except Exception as e:
                logging.warning(f"roost content-store reap failed: {e}", exc_info=True)

        t = threading.Thread(target=_run_scrub, daemon=True, name='roost-scrub')
        t.start()
        self._roost_scrub_thread = t

    def _check_scheduled_reboot(self):
        """State-machine driven scheduled reboot check.

        Reads schedule from local config.json (synced by the Firestore listener),
        and reads/writes state to local reboot_state.json. Mirrors state to
        Firestore best-effort for dashboard visibility, but never blocks on it.

        Runs every REBOOT_CHECK_INTERVAL_SECONDS seconds via the main loop.
        """
        try:
            schedule = shared_utils.read_config(['rebootSchedule'])
            if not schedule or not schedule.get('enabled'):
                return
            entries = schedule.get('entries') or []
            if not entries:
                return

            state = reboot_state.read_state()

            # Branch 1: handle in-progress attempt (retry/escalate)
            if state.get('attempt') and state['attempt'].get('status') == 'pending':
                self._handle_pending_reboot_attempt(state)
                return

            # Deliberately NO uptime floor and NO post-reboot grace: an entry
            # fires on its instant however recently the machine booted. Loops are
            # prevented structurally by per-entry, per-day lastFiredByEntry dedup;
            # an uptime floor only blocked legitimate back-to-back schedules.

            current_ids = {e.get('id') for e in entries if e.get('id')}
            state = reboot_state.prune_orphaned_entries(state, current_ids)

            # MACHINE-local, not site timezone — see _now_in_local_tz().
            # "Schedules follow site time" does NOT reach here: it moves PROCESS
            # windows only. Restart entries stay machine-local by design.
            today_date_iso = self._today_iso_in_local_tz()
            now_tz = self._now_in_local_tz()
            current_dayname = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'][now_tz.weekday()]

            for entry in entries:
                entry_id = entry.get('id')
                if not entry_id:
                    continue
                if current_dayname not in (entry.get('days') or []):
                    continue
                time_str = entry.get('time')
                if not time_str:
                    continue

                # timezone_str=None → resolve against the machine's local tz.
                scheduled_instant = shared_utils.compute_scheduled_instant(
                    now_tz.date(), time_str, None
                )
                if scheduled_instant is None:
                    continue
                age_seconds = (now_tz - scheduled_instant).total_seconds()
                if age_seconds < 0:
                    continue  # not yet due
                if state.get('lastFiredByEntry', {}).get(entry_id) == today_date_iso:
                    continue  # already fired today

                # Missed-fire grace. Observed too late (restart, deploy, edit,
                # offline window, cleared dedup state) → do NOT fire; mark
                # fired-for-the-day so it can't retry, and report 'missed'.
                if age_seconds > REBOOT_MISSED_FIRE_GRACE_SECONDS:
                    logging.warning(
                        f"Scheduled reboot MISSED for entry {entry_id} "
                        f"(scheduled {scheduled_instant.isoformat()}, "
                        f"observed {int(age_seconds)}s late) — skipping, will not refire today"
                    )
                    state.setdefault('lastFiredByEntry', {})[entry_id] = today_date_iso
                    reboot_state.write_state(state)
                    if self.firebase_client:
                        try:
                            self.firebase_client.mirror_reboot_state(state)
                            self.firebase_client.log_event(
                                action='scheduled_reboot_missed',
                                level='warning',
                                details=(
                                    f'missed by {int(age_seconds)}s — scheduled '
                                    f'{scheduled_instant.isoformat()} (entry {entry_id[:8]})'
                                )
                            )
                        except Exception as e:
                            logging.debug(f"Failed to mirror missed reboot (non-critical): {e}")
                    continue

                self._fire_scheduled_reboot(state, entry_id, scheduled_instant)
                return  # only one fire per check cycle

        except Exception as e:
            logging.error(f"Scheduled reboot check failed: {e}", exc_info=True)

    def _fire_scheduled_reboot(self, state, entry_id, scheduled_instant):
        """Fire a scheduled reboot using the announce-then-execute pattern.

        Sequence:
          1. Persist a 'pending' attempt to local reboot_state.json (durable).
          2. ANNOUNCE to Firestore — best-effort with retry. Writes a single
             atomic merge of (rebootScheduledAt, rebooting, rebootSource,
             rebootCancellable, rebootEntryId) so the dashboard sees a
             consistent state in one listener tick. rebootScheduledAt is a
             client-computed UTC wall-clock instant — NOT a server timestamp —
             so the dashboard can render the countdown the moment it sees the
             doc, with no second round trip required.
          3. PRE-ROLL: short fixed sleep so the dashboard listener has time
             to receive the announce and render the countdown BEFORE the
             Windows toast appears. Tunable via REBOOT_ANNOUNCE_PREROLL_SECONDS.
          4. Issue `shutdown /r /t REBOOT_OS_COUNTDOWN_SECONDS`. The agent
             main loop stays alive during the OS countdown and processes
             cancel commands in real time.
          5. If the OS shutdown command itself fails: clear all state and
             flags, log the failure. NEVER retry.

        OFFLINE BEHAVIOUR (CRITICAL): if Firestore is unreachable or the
        announce fails after retries, the reboot STILL FIRES. The whole
        point of local reboot_state.json + lastFiredByEntry + the 5-min
        missed-fire window is to make scheduled reboots resilient to
        internet outages. The local state machine is the source of truth.
        Firestore is a visibility channel for the dashboard — not an
        authorization gate. Without this property a kiosk in a museum with
        flaky wifi would silently stop rebooting on schedule.

        NO RETRIES on the OS shutdown itself anywhere in this code path.
        """
        now_utc = datetime.datetime.now(datetime.timezone.utc)
        target_reboot_at = now_utc + datetime.timedelta(
            seconds=REBOOT_ANNOUNCE_PREROLL_SECONDS + REBOOT_OS_COUNTDOWN_SECONDS
        )
        target_reboot_at_iso = target_reboot_at.isoformat()
        # Unix seconds, matching lastHeartbeat. A plain number, NOT a
        # server-resolved timestamp, so the countdown renders on first read.
        target_reboot_at_unix = int(target_reboot_at.timestamp())
        today_date_iso = self._today_iso_in_local_tz()

        logging.info(
            f"Scheduled reboot firing for entry {entry_id} "
            f"(scheduled for {scheduled_instant.isoformat()}, "
            f"target reboot at {target_reboot_at_iso})"
        )

        # 1. Persist local attempt FIRST — durable record before any network I/O.
        state['attempt'] = {
            'entryId': entry_id,
            'scheduledFor': scheduled_instant.isoformat(),
            'targetRebootAt': target_reboot_at_iso,
            'lastAttemptAt': now_utc.isoformat(),
            'status': 'pending',
        }
        reboot_state.write_state(state)
        self._reboot_attempt_started_monotonic = time.monotonic()

        # Owlette-initiated, so the next startup classifier stays silent.
        try:
            session_state.set_intent("owlette_reboot")
        except Exception as e:
            logging.debug(f"session_state.set_intent failed in scheduled reboot: {e}")

        # 2. Announce to Firestore: one atomic write, best-effort. Failure does
        # NOT abort the fire — local state is the source of truth.
        announced = False
        if self.firebase_client:
            announce_payload = {
                'rebootScheduledAt': target_reboot_at_unix,
                'rebooting': True,
                'rebootSource': 'scheduled',
                'rebootCancellable': True,
                'rebootEntryId': entry_id,
            }
            for announce_attempt in range(1, 4):
                try:
                    self.firebase_client.set_machine_flags(announce_payload)
                    self.firebase_client.mirror_reboot_state(state)
                    self.firebase_client.log_event(
                        action='scheduled_reboot_announced',
                        level='warning',
                        details=f'target {target_reboot_at_iso} (entry {entry_id[:8]})'
                    )
                    announced = True
                    logging.info(f"Reboot announce succeeded on attempt {announce_attempt}/3")
                    break
                except Exception as e:
                    logging.warning(
                        f"Reboot announce attempt {announce_attempt}/3 failed: {e}"
                    )
                    time.sleep(0.3)

            if not announced:
                logging.warning(
                    f"Reboot announce to Firestore FAILED after 3 attempts for entry "
                    f"{entry_id} — proceeding with reboot anyway (local state is source "
                    f"of truth; dashboard will not show countdown until next reconnect)"
                )

        # 3. Pre-roll so the dashboard renders the countdown; skipped offline.
        if announced:
            logging.info(
                f"Reboot pre-roll: sleeping {REBOOT_ANNOUNCE_PREROLL_SECONDS}s "
                f"for dashboard propagation before issuing OS shutdown"
            )
            time.sleep(REBOOT_ANNOUNCE_PREROLL_SECONDS)

        # 5. Issue OS shutdown.
        self._shutting_down = True
        try:
            osadapter.reboot(
                REBOOT_OS_COUNTDOWN_SECONDS,
                'Owlette scheduled reboot — cancellable from dashboard',
            )
            logging.info(
                f"Scheduled reboot command issued ({REBOOT_OS_COUNTDOWN_SECONDS}s OS countdown)"
            )
        except Exception as e:
            # 6. OS shutdown failed. Clear state, clear flags, never retry.
            logging.error(f"Failed to issue shutdown command: {e}")
            self._shutting_down = False
            self._reboot_attempt_started_monotonic = None
            state['attempt'] = None
            state.setdefault('lastFiredByEntry', {})[entry_id] = today_date_iso
            reboot_state.write_state(state)
            if self.firebase_client:
                try:
                    self.firebase_client.set_machine_flags({
                        'rebooting': False,
                        'rebootScheduledAt': None,
                        'rebootCancellable': False,
                    })
                    self.firebase_client.mirror_reboot_state(state)
                    self.firebase_client.log_event(
                        action='scheduled_reboot_failed',
                        level='error',
                        details=f'shutdown command failed: {e} (entry {entry_id[:8]})'
                    )
                except Exception as inner:
                    logging.debug(f"Failed to clear flags after shutdown failure: {inner}")

    def _handle_pending_reboot_attempt(self, state):
        """Called when state.attempt.status == 'pending'.

        NO RETRIES. There are exactly two cases:

        1. We fired this session and the OS shutdown is in progress —
           _reboot_attempt_started_monotonic is set. Do nothing; wait for
           the OS to actually shut down. The next service start will run
           _detect_reboot_success_on_startup and clear the attempt.

        2. The attempt is stale: we found a 'pending' record that was NOT
           started by this process (service restarted, agent crashed mid-fire,
           cancel didn't clean up, etc). Treat as FAILED. Clear the attempt,
           stamp lastFiredByEntry so it cannot retry today, log a failure
           event. Never re-issue a shutdown.

        This is the "no retries" safety guarantee. A failed reboot is logged
        and dropped — it does not silently re-fire hours later.
        """
        # Case 1: in-flight in this process — let the OS finish what we started.
        if self._reboot_attempt_started_monotonic is not None:
            return

        # Case 2: stale attempt from a previous process. Treat as failed.
        attempt = state.get('attempt') or {}
        entry_id = attempt.get('entryId')
        scheduled_for = attempt.get('scheduledFor')

        today_date_iso = self._today_iso_in_local_tz()
        if entry_id:
            state.setdefault('lastFiredByEntry', {})[entry_id] = today_date_iso
        state['attempt'] = None
        reboot_state.write_state(state)

        logging.error(
            f"Stale reboot attempt found for entry {entry_id} (scheduled {scheduled_for}) — "
            f"treating as FAILED, will not retry today"
        )
        if self.firebase_client:
            try:
                self.firebase_client.mirror_reboot_state(state)
                self.firebase_client.set_machine_flags({
                    'rebooting': False,
                    'rebootScheduledAt': None,
                    'rebootCancellable': False,
                })
                self.firebase_client.log_event(
                    action='scheduled_reboot_failed',
                    level='error',
                    details=(
                        f'stale attempt cleared on service start — no retry, '
                        f'scheduled {scheduled_for} (entry {entry_id[:8]})'
                    )
                )
            except Exception as e:
                logging.debug(f"Failed to mirror failed reboot (non-critical): {e}")

    # Reboot schedules are MACHINE-local wall clock, never site timezone: a
    # "14:00" entry must fire at 14:00 in Tokyo and 14:00 in NYC. The dashboard
    # dialog is timezone-agnostic for this reason.
    #
    # Process schedules (is_within_schedule) DO use the site timezone on purpose,
    # but only for sites that opted in (schedulesFollowSiteTime) — office-hours
    # windows want every machine aligned. Sites that declined, and sites on agents
    # older than 3.3.0, evaluate those windows machine-locally too. Either way the
    # two schedule kinds stay separate: don't unify them.

    def _now_in_local_tz(self):
        """Return now() in the MACHINE's local timezone (not the site timezone).

        Uses datetime.now().astimezone() which picks up the OS's configured
        timezone — the same one Windows shows in the system tray clock.
        """
        return datetime.datetime.now().astimezone()

    def _today_iso_in_local_tz(self):
        """Return today's date in the machine's local timezone as 'YYYY-MM-DD'."""
        return self._now_in_local_tz().date().isoformat()

    def _clean_shutdown_in_event_log(self, window_start, window_end):
        """Whether the OS recorded an orderly shutdown in the given epoch window.

        Three answers, not two: True with a record, False with none, and None
        where this OS keeps no record the agent can read. Without a source,
        an absent record is the absence of evidence rather than evidence of a
        crash, and the classifier must not report one.

        EventID 1074 (User32 — a shutdown was initiated, by whom and why) and
        6006 (the event log service stopped) are the OS's own record of a clean
        stop. The agent can miss its own signal — it is killed inside the ~5s
        Windows allows — and this is the only corroboration left afterwards.

        The window must stay tight around when the agent was last alive: an
        orderly shutdown long afterwards is a different event, and accepting it
        would explain away the outage in between.

        Bounded subprocess, and any failure or timeout means NO evidence: an
        unexpected reboot must never be explained away by a broken query.
        """
        if sys.platform != 'win32':
            return None
        if window_end <= window_start:
            return False

        def _iso(epoch):
            return datetime.datetime.fromtimestamp(
                epoch, tz=datetime.timezone.utc).strftime('%Y-%m-%dT%H:%M:%S.000Z')

        query = (
            "*[System[(EventID=1074 or EventID=6006) and "
            f"TimeCreated[@SystemTime>='{_iso(window_start)}' and "
            f"@SystemTime<='{_iso(window_end)}']]]"
        )

        try:
            result = subprocess.run(
                ['wevtutil', 'qe', 'System', f'/q:{query}', '/c:1', '/rd:true', '/f:text'],
                capture_output=True, text=True, timeout=5,
                creationflags=subprocess.CREATE_NO_WINDOW,
            )
        except Exception as e:
            logging.debug(f"Shutdown corroboration query failed: {e}")
            return False

        if result.returncode != 0:
            logging.debug(
                f"Shutdown corroboration query returned {result.returncode}: "
                f"{(result.stderr or '').strip()[:200]}"
            )
            return False

        return bool((result.stdout or '').strip())

    def _classify_startup_session(self):
        """Detect anomalous prior shutdowns and queue a warning event if needed.

        Compares the persisted session state from the previous run against
        the current psutil.boot_time(). Result is stored in
        self._pending_anomaly_event for emission once Firebase is connected
        (mirrors the _pending_update_event pattern).

        Silent on first run, schema mismatch, version change (upgrades), and
        Owlette-initiated stops. Emits warning events for external operator
        reboots, no-signal crashes/BSODs, and unexplained service restarts.

        After classification, writes a fresh session_state.json for this boot
        with shutdown_intent=None — subsequent reboot/shutdown handlers will
        set the intent before issuing OS commands.
        """
        self._pending_anomaly_event = None

        try:
            prev = session_state.read_state()
            current_boot = int(psutil.boot_time())
            current_version = shared_utils.APP_VERSION

            # Written even when we return silently below: set_intent and
            # update_alive need a baseline file to mutate.
            try:
                session_state.init_session(version=current_version, boot_time=current_boot)
            except Exception as e:
                logging.warning(f"Failed to init session_state.json: {e}")

            # Silent guards (in priority order)
            if prev is None:
                logging.info("Session classifier: no prior state (first run) — silent")
                return
            if prev.get('schema') != session_state.SCHEMA_VERSION:
                logging.info(
                    f"Session classifier: schema mismatch (prev={prev.get('schema')}) — silent"
                )
                return
            if prev.get('version') != current_version:
                logging.info(
                    f"Session classifier: version changed "
                    f"({prev.get('version')} -> {current_version}) — silent"
                )
                return

            prev_boot = prev.get('boot_time')
            intent = prev.get('shutdown_intent')
            last_alive = int(prev.get('last_alive') or 0)

            # 5-second tolerance absorbs psutil.boot_time() jitter on Windows
            boot_changed = prev_boot is None or abs(current_boot - int(prev_boot)) > 5

            if boot_changed:
                # Owlette-initiated reboot/shutdown — silent
                if intent in ('owlette_reboot', 'owlette_shutdown'):
                    logging.info(f"Session classifier: planned reboot ({intent}) — silent")
                    return
                gap = max(0, current_boot - last_alive)
                if intent == 'external_clean':
                    action = 'external_reboot'
                    details = (
                        f'boot detected after clean shutdown signal, '
                        f'last alive {gap}s before boot'
                    )
                else:
                    corroborated = self._clean_shutdown_in_event_log(
                        last_alive - SHUTDOWN_EVIDENCE_LEAD_SECONDS,
                        last_alive + SHUTDOWN_EVIDENCE_TRAIL_SECONDS,
                    ) if last_alive > 0 else False
                    if corroborated is None:
                        # No record to consult on this platform, so nothing
                        # distinguishes an orderly restart from a crash —
                        # reporting one would warn on every clean POSIX boot.
                        logging.info(
                            f"Session classifier: boot with no shutdown signal and "
                            f"no corroboration source on this platform — silent "
                            f"(last alive {gap}s before boot)"
                        )
                        return
                    if corroborated:
                        # Same verdict as intent=='external_clean' above, reached
                        # the other way: the agent lost the race to write its own
                        # signal, but Windows kept the receipt.
                        action = 'external_reboot'
                        details = (
                            f'clean shutdown corroborated by Windows event log (1074/6006); '
                            f'agent captured no shutdown signal, '
                            f'last alive {gap}s before boot'
                        )
                    else:
                        action = 'unexpected_reboot'
                        details = (
                            f'boot detected with no shutdown signal, '
                            f'last alive {gap}s before boot'
                        )
                logging.warning(f"Session classifier: {action} — {details}")
                self._pending_anomaly_event = (action, details)
            else:
                # Agent restart without an OS reboot. Silent for all known
                # intents — _handle_pending_reboot_attempt already reports a
                # failed owlette reboot as scheduled_reboot_failed.
                if intent is not None:
                    logging.info(
                        f"Session classifier: planned service restart ({intent}) — silent"
                    )
                    return
                gap = max(0, int(time.time()) - last_alive)
                details = (
                    f'agent restarted with no shutdown signal, '
                    f'last alive {gap}s ago'
                )
                logging.warning(
                    f"Session classifier: unexpected_service_restart — {details}"
                )
                self._pending_anomaly_event = ('unexpected_service_restart', details)
        except Exception as e:
            logging.error(f"Session classifier failed: {e}", exc_info=True)

    def _detect_reboot_success_on_startup(self):
        """If a pending reboot attempt persisted across the boot, detect success.

        Called once during service init (after Firebase client is available but
        possibly disconnected). Compares psutil.boot_time() against the persisted
        attempt timestamp. If we did boot since the attempt, marks the entry as
        fulfilled and advances any other entries whose scheduled instant fell
        within the last hour (handles multi-entry-within-minutes case).
        """
        try:
            state = reboot_state.read_state()
            attempt = state.get('attempt')
            if not attempt or attempt.get('status') != 'pending':
                return

            try:
                last_attempt_at = datetime.datetime.fromisoformat(attempt['lastAttemptAt'])
            except (KeyError, ValueError):
                return

            boot_dt = datetime.datetime.fromtimestamp(psutil.boot_time(), tz=datetime.timezone.utc)
            if boot_dt <= last_attempt_at:
                return  # we haven't booted since the attempt — not a success

            logging.info("Reboot success detected — clearing pending attempt")

            # ALL entries whose instant fell in the last hour, in MACHINE-local
            # time (same convention as _check_scheduled_reboot).
            schedule = shared_utils.read_config(['rebootSchedule']) or {}
            entries = schedule.get('entries') or []
            now_tz = self._now_in_local_tz()
            today = now_tz.date()
            yesterday = today - datetime.timedelta(days=1)
            day_names = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun']

            state.setdefault('lastFiredByEntry', {})
            for entry in entries:
                entry_id = entry.get('id')
                time_str = entry.get('time')
                days = entry.get('days') or []
                if not entry_id or not time_str:
                    continue
                # Check yesterday and today separately — covers reboots near midnight
                for candidate_date in (yesterday, today):
                    dayname = day_names[candidate_date.weekday()]
                    if dayname not in days:
                        continue
                    # timezone_str=None → resolves the entry against machine local tz
                    sched_instant = shared_utils.compute_scheduled_instant(
                        candidate_date, time_str, None
                    )
                    if sched_instant is None:
                        continue
                    boot_in_local_tz = boot_dt.astimezone(sched_instant.tzinfo) if sched_instant.tzinfo else boot_dt
                    delta = (boot_in_local_tz - sched_instant).total_seconds()
                    if 0 <= delta <= REBOOT_SUCCESS_DETECTION_WINDOW_SECONDS:
                        state['lastFiredByEntry'][entry_id] = candidate_date.isoformat()

            state['attempt'] = None
            reboot_state.write_state(state)
            self._reboot_attempt_started_monotonic = None

            if self.firebase_client and self.firebase_client.is_connected():
                try:
                    self.firebase_client.mirror_reboot_state(state)
                    self.firebase_client.log_event(
                        action='scheduled_reboot_success',
                        level='info',
                        details=f'reboot succeeded (entry {attempt.get("entryId", "")[:8]})'
                    )
                except Exception as e:
                    logging.debug(f"Failed to mirror reboot success (non-critical): {e}")
        except Exception as e:
            logging.warning(f"Reboot success detection failed: {e}")

    def _handle_reboot_machine(self, command_data):
        """Handle remote reboot command."""
        try:
            self.firebase_client.log_event(
                action='command_executed',
                level='warning',
                details='Remote reboot initiated from dashboard'
            )

            # Suppresses crash alerts and drives the dashboard pill. The Unix
            # target matches `shutdown /r /t`, so the pill renders on the same
            # listener tick.
            self._shutting_down = True
            try:
                session_state.set_intent("owlette_reboot")
            except Exception as e:
                logging.debug(f"session_state.set_intent failed in manual reboot: {e}")
            target_reboot_at_unix = int(
                (datetime.datetime.now(datetime.timezone.utc)
                 + datetime.timedelta(
                     seconds=REBOOT_OS_COUNTDOWN_SECONDS)).timestamp()
            )
            try:
                self.firebase_client.set_machine_flags({
                    'rebootScheduledAt': target_reboot_at_unix,
                    'rebooting': True,
                    'rebootSource': 'manual',
                    'rebootCancellable': True,
                })
            except Exception as flag_err:
                # Local state is source of truth; Firestore is only visibility
                # (same offline-resilient behaviour as _fire_scheduled_reboot).
                logging.warning(
                    f"Failed to announce manual reboot to Firestore (proceeding anyway): {flag_err}"
                )

            # The pill's countdown and the OS's are the same constant:
            # whole minutes is the coarsest grain a platform schedules on
            # (the Linux arm rounds up and never rests below one), so a
            # shorter announcement reaches zero before the machine goes.
            osadapter.reboot(
                REBOOT_OS_COUNTDOWN_SECONDS, 'owlette remote reboot requested')

            return f"Reboot scheduled in {REBOOT_OS_COUNTDOWN_SECONDS} seconds"
        except Exception as e:
            return f"Reboot failed: {str(e)}"

    def _handle_shutdown_machine(self, command_data):
        """Handle remote shutdown command."""
        try:
            self.firebase_client.log_event(
                action='command_executed',
                level='warning',
                details='Remote shutdown initiated from dashboard'
            )

            self._shutting_down = True
            try:
                session_state.set_intent("owlette_shutdown")
            except Exception as e:
                logging.debug(f"session_state.set_intent failed in manual shutdown: {e}")
            target_shutdown_at_unix = int(
                (datetime.datetime.now(datetime.timezone.utc)
                 + datetime.timedelta(
                     seconds=REBOOT_OS_COUNTDOWN_SECONDS)).timestamp()
            )
            try:
                self.firebase_client.set_machine_flags({
                    'shutdownScheduledAt': target_shutdown_at_unix,
                    'shuttingDown': True,
                    'rebootSource': 'manual',
                })
            except Exception as flag_err:
                # Local state is source of truth; Firestore is a visibility channel.
                logging.warning(
                    f"Failed to announce manual shutdown to Firestore (proceeding anyway): {flag_err}"
                )

            osadapter.shutdown(
                REBOOT_OS_COUNTDOWN_SECONDS,
                'owlette remote shutdown requested')

            return f"Shutdown scheduled in {REBOOT_OS_COUNTDOWN_SECONDS} seconds"
        except Exception as e:
            return f"Shutdown failed: {str(e)}"

    def _handle_cancel_reboot(self, command_data):
        """Cancel a pending reboot/shutdown.

        Aborts the OS-level shutdown through the adapter, clears all in-flight
        reboot state both locally and in Firestore, and — critically — stamps
        lastFiredByEntry for any in-progress scheduled-reboot attempt so the
        same entry cannot re-fire today on the next scheduler tick.
        """
        try:
            os_cancel_ok = osadapter.cancel_reboot()

            self._shutting_down = False
            self._reboot_attempt_started_monotonic = None

            # Stamp lastFiredByEntry for an in-progress attempt so it can't
            # re-fire today.
            try:
                state = reboot_state.read_state()
                attempt = state.get('attempt') or {}
                entry_id = attempt.get('entryId')
                if entry_id:
                    today_date_iso = self._today_iso_in_local_tz()
                    state.setdefault('lastFiredByEntry', {})[entry_id] = today_date_iso
                state['attempt'] = None
                reboot_state.write_state(state)
                if self.firebase_client:
                    try:
                        self.firebase_client.mirror_reboot_state(state)
                    except Exception as e:
                        logging.debug(f"Failed to mirror cancelled reboot state: {e}")
            except Exception as e:
                logging.warning(f"Failed to clear local reboot state on cancel: {e}")

            if self.firebase_client:
                try:
                    self.firebase_client.set_machine_flags({
                        'rebooting': False,
                        'shuttingDown': False,
                        'rebootScheduledAt': None,
                        'shutdownScheduledAt': None,
                        'rebootCancellable': False,
                    })
                    self.firebase_client.log_event(
                        action='command_executed',
                        level='info',
                        details='Pending reboot/shutdown cancelled from dashboard'
                    )
                except Exception as e:
                    logging.warning(f"Failed to clear reboot flags on cancel: {e}")

            if os_cancel_ok:
                # Only on a cancel the OS accepted: if it already committed,
                # the intent must survive so the reboot still classifies as
                # planned.
                try:
                    session_state.set_intent(None)
                except Exception as e:
                    logging.debug(f"session_state.set_intent(None) failed on cancel: {e}")
                return "Reboot/shutdown cancelled"
            return "No pending OS reboot to cancel (state cleared)"
        except subprocess.TimeoutExpired:
            return "Cancel timed out (the OS cancel hung)"

    def _handle_dismiss_reboot_pending(self, command_data):
        """Dismiss a reboot pending prompt and reset relaunch counters."""
        try:
            process_name = command_data.get('process_name')

            self.firebase_client.clear_reboot_pending()

            # Reset relaunch counter for the affected process so it gets fresh attempts
            if process_name and process_name in self.relaunch_attempts:
                del self.relaunch_attempts[process_name]
                logging.info(f"Reset relaunch counter for {process_name}")

            # The desktop app owns closing the window; the service only drops its
            # own "prompt is up" gate so a later exceedance can prompt again.
            self._restart_prompt_until = 0.0

            self.firebase_client.log_event(
                action='command_executed',
                level='info',
                process_name=process_name,
                details='Reboot dismissed by admin from dashboard'
            )

            return f"Reboot pending dismissed, relaunch counters reset for {process_name}"
        except Exception as e:
            return f"Failed to dismiss reboot pending: {str(e)}"

    def _handle_provision_cortex_key(self, command_data):
        """Encrypt and store the Cortex LLM API key in config.json."""
        try:
            api_key = command_data.get('api_key', '')
            provider = command_data.get('provider', 'anthropic')

            if not api_key:
                return "Error: No API key provided"

            # The same machine-bound key the token store uses; owlette_cortex
            # reads it back through decrypt_value.
            from secure_storage import get_storage
            storage = get_storage()
            encrypted = storage.encrypt_value(api_key)

            # write_config takes (key path, value) — the whole branch is written
            # in one call so the three fields land together, and re-reading the
            # existing branch first keeps any other cortex settings intact.
            cortex = dict((shared_utils.read_config() or {}).get('cortex') or {})
            cortex['apiKeyEncrypted'] = encrypted
            cortex['provider'] = provider
            cortex['enabled'] = True
            shared_utils.write_config(['cortex'], cortex)

            logging.info(f"Cortex API key provisioned (provider={provider})")
            return "Cortex API key provisioned successfully"
        except Exception as e:
            logging.error(f"Failed to provision Cortex key: {e}")
            return f"Error: {str(e)}"

    def _try_user_session_tool(self, tool_name, tool_params):
        """Handle MCP tools that require user-session execution.

        Returns:
            dict result if handled, None if the tool should fall through
            to the standard mcp_tools.execute_tool() path.
        """
        if tool_name == 'run_command' and tool_params.get('user_session'):
            command = tool_params.get('command', '').strip()
            if not command:
                return {'error': 'command parameter is required'}
            result = self.execute_in_user_session('cmd', command, timeout=25)
            return {
                'command': command,
                'exit_code': result.get('exitCode', -1),
                'stdout': result.get('stdout', ''),
                'stderr': result.get('stderr', ''),
                'user_session': True,
                'error': result.get('error'),
            }

        if tool_name == 'run_powershell' and tool_params.get('user_session'):
            script = tool_params.get('script', '').strip()
            if not script:
                return {'error': 'script parameter is required'}
            result = self.execute_in_user_session('powershell', script, timeout=25)
            return {
                'script': script,
                'exit_code': result.get('exitCode', -1),
                'stdout': result.get('stdout', ''),
                'stderr': result.get('stderr', ''),
                'user_session': True,
                'error': result.get('error'),
            }

        if tool_name == 'run_python':
            code = tool_params.get('code', '').strip()
            if not code:
                return {'error': 'code parameter is required'}
            result = self.execute_in_user_session('python', code, timeout=25)
            return {
                'exit_code': result.get('exitCode', -1),
                'stdout': result.get('stdout', ''),
                'stderr': result.get('stderr', ''),
                'files': result.get('files', []),
                'duration_ms': result.get('durationMs', 0),
                'error': result.get('error'),
            }

        if tool_name == 'capture_screenshot':
            return self._handle_capture_screenshot({
                'monitor': tool_params.get('monitor', 0),
            })

        return None  # Not a user-session tool, fall through

    def _run_capture_pipeline(self, monitor=0, include_image_bytes=False, **budget):
        """Capture one screenshot in the console session and upload it.

        The single agent-side capture path: grab through session_exec, PUT the
        JPEG to a signed url, then finalize so web writes machine.lastScreenshot.
        Returns capture_and_upload's envelope and raises ScreenshotCaptureError
        — what a failure means is the caller's decision.

        `budget` (max_width / quality / capture_timeout_s /
        max_upload_attempts) is forwarded to capture_and_upload, which holds the
        on-demand defaults; the crash and live-view callers pass their own.
        """
        fb = self.firebase_client
        site_id = getattr(fb, 'site_id', None)
        machine_id = getattr(fb, 'machine_id', None)
        auth_manager = getattr(fb, 'auth_manager', None)
        if not site_id or not machine_id or auth_manager is None:
            raise ScreenshotCaptureError(
                'capture: no authenticated cloud client to upload through'
            )

        try:
            token = auth_manager.get_valid_token()
        except Exception as e:
            raise ScreenshotCaptureError(
                f'capture: could not obtain a valid auth token: {e}'
            ) from e

        return capture_and_upload(
            user_session_executor=self.execute_in_user_session,
            api_base=shared_utils.get_api_base_url(),
            site_id=site_id,
            machine_id=machine_id,
            bearer_token=token,
            monitor=monitor,
            include_image_bytes=include_image_bytes,
            **budget,
        )

    def _capture_crash_screenshot(self):
        """Best-effort screenshot capture on process crash. Returns URL or None.

        Shares the capture pipeline with _handle_capture_screenshot and never
        raises into the relaunch path. Runs inline on the monitor loop, so the
        whole call is held to the ~38s worst case the single-request upload it
        replaced had: 8s to capture plus 10s for each of the three round-trips,
        one attempt. A slow upload here stalls every other process on the
        machine.
        """
        try:
            result = self._run_capture_pipeline(
                max_width=1920,
                quality=60,
                capture_timeout_s=8,
                request_timeout_s=10,
                max_upload_attempts=1,
            )
        except Exception as e:
            logging.debug(f"Crash screenshot failed: {e}")
            return None

        url = result.get('url') or None
        if url:
            logging.info(f"Crash screenshot captured: {result['size_kb']}KB")
        return url

    # Tier 3 tools that warrant site-log entries on success
    _TIER3_TOOLS = frozenset([
        'run_command', 'run_powershell', 'execute_script', 'run_python',
        'write_file', 'reboot_machine', 'shutdown_machine',
    ])

    def _log_cortex_tool(self, tool_name, tool_params, result):
        """Log Cortex tool calls to site logs — always on error, Tier 3 on success."""
        try:
            has_error = isinstance(result, dict) and 'error' in result
            if has_error:
                detail_parts = [f'Tool {tool_name} failed']
                error_msg = result['error']
                detail_parts.append(error_msg)
                self.firebase_client.log_event(
                    action='command_executed',
                    level='error',
                    details=' — '.join(detail_parts),
                )
            elif tool_name in self._TIER3_TOOLS:
                # Script-bearing tools keep 500 chars, newlines intact — 100 chars
                # of line 1 didn't show an auditor what actually ran.
                detail = f'Cortex: {tool_name}'
                if tool_name == 'run_command' and 'command' in tool_params:
                    cmd = tool_params['command']
                    if len(cmd) > 100:
                        cmd = cmd[:100] + '...'
                    detail += f' — {cmd}'
                elif tool_name in ('run_powershell', 'execute_script') and 'script' in tool_params:
                    # 500 chars, not 100: a first-line truncation hides what a
                    # multi-line PowerShell/Python body actually ran.
                    script = tool_params.get('script') or ''
                    preview = script[:500]
                    if len(script) > 500:
                        preview += '...'
                    detail += f'\n{preview}'
                elif tool_name == 'write_file' and 'path' in tool_params:
                    detail += f' — {tool_params["path"]}'
                self.firebase_client.log_event(
                    action='command_executed',
                    level='info',
                    details=detail,
                )
        except Exception as e:
            logging.debug(f"Failed to log Cortex tool event: {e}")

    def _handle_capture_screenshot(self, command_data):
        """Handle screenshot capture via user-session execution.

        Returns the on-demand envelope the hoot tool and the Cortex IPC
        caller read: {message, url, size_kb, monitor}, or {error}. With
        `include_image` the envelope also carries the jpeg as `base64`, which
        only the Cortex IPC caller asks for — the hoot tool result is json-dumped
        into a Firestore command document and has a 1 MB ceiling.
        """
        try:
            include_image = bool(command_data.get('include_image'))
            result = self._run_capture_pipeline(
                command_data.get('monitor', 0),
                include_image_bytes=include_image,
            )

            size_kb = result['size_kb']
            monitor = result['monitor']
            url = result['url']

            logging.info(f"Screenshot captured: {size_kb}KB")

            self.firebase_client.log_event(
                action='command_executed',
                level='info',
                details=f'Screenshot captured ({size_kb}KB)'
            )

            monitor_label = f'monitor {monitor}' if monitor > 0 else 'all monitors'
            message = f"Screenshot captured ({monitor_label}, {size_kb}KB)"
            if url:
                message += f" — URL: {url}"

            response = {
                'message': message,
                'url': url,
                'size_kb': size_kb,
                'monitor': monitor,
            }
            image_bytes = result.get('image_bytes')
            if image_bytes:
                response['base64'] = base64.b64encode(image_bytes).decode('ascii')
            return response

        except ScreenshotCaptureError as e:
            return {'error': f"Screenshot failed: {e}"}
        except Exception as e:
            return {'error': f"Screenshot failed: {type(e).__name__}: {e}"}

    def _handle_start_live_view(self, command_data):
        """Start periodic screenshot capture for live view."""
        try:
            interval = command_data.get('interval', 10)
            interval = max(5, min(60, int(interval)))
            duration = command_data.get('duration', 600)
            duration = max(60, min(1800, int(duration)))

            if self._live_view_active:
                return "Live view already active"

            self._live_view_active = True
            self._live_view_stop_time = time.time() + duration

            if self.firebase_client and self.firebase_client.is_connected():
                self.firebase_client.set_machine_flag('liveView', {
                    'active': True,
                    'interval': interval,
                    'startedAt': time.time(),
                    'expiresAt': self._live_view_stop_time,
                })

            thread = threading.Thread(
                target=self._live_view_loop,
                args=(interval,),
                daemon=True,
                name='LiveViewLoop',
            )
            thread.start()

            logging.info(f"Live view started: interval={interval}s, duration={duration}s")
            return f"Live view started (interval: {interval}s, duration: {duration}s)"

        except Exception as e:
            self._live_view_active = False
            return f"Error starting live view: {e}"

    def _handle_stop_live_view(self, command_data):
        """Stop the live view screenshot loop."""
        self._live_view_active = False

        if self.firebase_client and self.firebase_client.is_connected():
            self.firebase_client.set_machine_flag('liveView', {'active': False})

        logging.info("Live view stopped")
        return "Live view stopped"

    def _live_view_loop(self, interval):
        """Background loop that captures and uploads screenshots periodically."""
        try:
            logging.info(f"Live view loop started (interval={interval}s)")

            while self._live_view_active and time.time() < self._live_view_stop_time:
                try:
                    # A refreshing modal frame every 5-60s does not need the
                    # full-resolution on-demand image, and a frame that is
                    # slow to land is worth dropping rather than retrying:
                    # the next one is already due.
                    self._run_capture_pipeline(
                        max_width=1920,
                        quality=50,
                        capture_timeout_s=10,
                        request_timeout_s=10,
                        max_upload_attempts=1,
                    )
                except ScreenshotCaptureError as e:
                    logging.debug(f"Live view capture failed: {e}")
                except Exception as e:
                    logging.warning(f"Live view capture error: {e}")

                # Sleep in small increments so we can stop promptly
                sleep_end = time.time() + interval
                while self._live_view_active and time.time() < sleep_end and time.time() < self._live_view_stop_time:
                    time.sleep(1)

        except Exception as e:
            logging.error(f"Live view loop crashed: {e}")
        finally:
            self._live_view_active = False
            if self.firebase_client and self.firebase_client.is_connected():
                try:
                    self.firebase_client.set_machine_flag('liveView', {'active': False})
                except Exception:
                    pass
            logging.info("Live view loop ended")

    def _handle_update_owlette(self, cmd_id, cmd_data):
        """Accept a self-update and hand the install to something that outlives us.

        The installer stops the agent, so it never runs as a child of this
        process: Windows hands it to Task Scheduler, POSIX to a transient
        systemd unit or a launchd job. Off Windows the download and the package
        manager's own pre-check run on a worker as well - update_owlette shares
        the slow-command lane with every install and roost job, and an apt-get
        waiting on a held dpkg lock would hold all of them behind it. That arm
        answers COMMAND_DEFERRED: the worker outlives this call, so the
        terminal status is the worker's to write once the handoff resolves.
        """
        installer_url = cmd_data.get('installer_url')
        expected_sha256 = cmd_data.get('checksum_sha256')

        target_version = cmd_data.get('target_version')
        if not target_version:
            version_match = re.search(r'v(\d+\.\d+\.\d+)', installer_url or '')
            target_version = version_match.group(1) if version_match else 'unknown'

        if not installer_url:
            return "Error: No installer URL provided for update"

        # ANTI-FRAGILE: Require checksum for self-updates (supply chain protection)
        if not expected_sha256:
            return "Error: No checksum provided for self-update - refusing to install unverified binary"

        # ANTI-FRAGILE: Idempotency guard - prevent concurrent update execution
        in_progress = self._update_already_in_progress()
        if in_progress:
            return in_progress

        logging.info("="*60)
        logging.info("OWLETTE SELF-UPDATE INITIATED")
        logging.info(f"Current version: {shared_utils.APP_VERSION}")
        logging.info(f"Target version: {target_version}")
        logging.info("="*60)
        logging.debug(f"Installer URL: {installer_url}")
        logging.debug(f"Checksum: {expected_sha256[:16]}...")

        os_family = shared_utils.get_os_family_arch()[0]

        # Before the download, not after it: off Windows the command lane is
        # released the moment this returns, so a marker written once the
        # installer is on disk would leave the guard above covering nothing
        # for the minutes a download takes.
        self._write_update_marker(cmd_id, cmd_data, target_version)

        if os_family == 'windows':
            return self._run_self_update(cmd_id, cmd_data, target_version, os_family)

        threading.Thread(
            target=self._self_update_worker,
            args=(cmd_id, cmd_data, target_version, os_family),
            name='self-update',
            daemon=True,
        ).start()
        return COMMAND_DEFERRED

    def _update_already_in_progress(self):
        """The refusal for a self-update that is already running, else None.

        A marker older than ten minutes belongs to an update that never
        finished; it must not block the retry.
        """
        marker_path = shared_utils.get_data_path('logs/update_in_progress.json')
        if not os.path.exists(marker_path):
            return None

        try:
            with open(marker_path, 'r') as f:
                existing_marker = json.load(f)
            marker_time = datetime.datetime.strptime(
                existing_marker.get('started_at', ''), '%Y-%m-%d %H:%M:%S')
            age_minutes = (datetime.datetime.now() - marker_time).total_seconds() / 60
        except Exception as marker_err:
            logging.warning(f"Could not read existing update marker, proceeding: {marker_err}")
            return None

        if age_minutes < 10:
            logging.warning(
                f"Update already in progress (started {age_minutes:.1f}m ago) - "
                f"rejecting duplicate command")
            return f"Update already in progress (started {age_minutes:.1f}m ago)"

        logging.warning(
            f"Stale update marker found ({age_minutes:.1f}m old) - proceeding with new update")
        return None

    def _self_update_worker(self, cmd_id, cmd_data, target_version, os_family):
        """Run the self-update off the command lane and write its own result.

        The lane was released the moment the update was accepted, so the
        terminal status is this thread's to write: an install that never
        started leaves this version running, and nothing else would ever say
        so. One that does start reports again from the next boot, through the
        marker.
        """
        result = self._run_self_update(cmd_id, cmd_data, target_version, os_family)
        if result.startswith('Error:'):
            logging.error(result)
        else:
            logging.info(result)

        if self.firebase_client:
            try:
                self.firebase_client.finish_command(cmd_id, cmd_data, result)
            except Exception as e:
                logging.error(f"Could not report the self-update result: {e}")

    def _run_self_update(self, cmd_id, cmd_data, target_version, os_family):
        """Download, verify and hand off the installer; returns the result string."""
        installer_url = cmd_data.get('installer_url')
        expected_sha256 = cmd_data.get('checksum_sha256')
        deployment_id = cmd_data.get('deployment_id')
        update_marker_path = shared_utils.get_data_path('logs/update_in_progress.json')

        try:
            self._check_update_disk_space()

            if self.firebase_client:
                self.firebase_client.update_command_progress(cmd_id, 'downloading', deployment_id)

            # Our own staging dir, not the system temp one - security
            # software blocks execution from there. The name carries the
            # family's extension: apt-get refuses a package that is not
            # called `.deb`.
            temp_installer_path = os.path.join(
                self._update_staging_dir(),
                installer_utils.UPDATE_ARTIFACT_NAMES[os_family])

            logging.info("Downloading installer (3 retries with exponential backoff)...")
            download_success, actual_path = installer_utils.download_file(
                installer_url,
                temp_installer_path,
                progress_callback=None,  # Progress already tracked via Firestore status
                max_retries=3,
                connect_timeout=30,
                read_timeout=600
            )

            if not download_success:
                raise Exception(f"Failed to download installer after 3 retries from {installer_url}")

            temp_installer_path = actual_path
            logging.debug(f"Installer downloaded to: {temp_installer_path}")

            # The size floor and this family's magic, before anything is run:
            # MACHINE_EXEC_COMMAND is held by the cortex and talon actors too,
            # so a correctly-checksummed package for another OS would otherwise
            # be a way to brick a kiosk.
            installer_utils.verify_artifact_family(temp_installer_path, os_family)

            # SHA256 checksum verification (MANDATORY for self-updates)
            logging.info("Verifying installer checksum...")
            if not installer_utils.verify_checksum(temp_installer_path, expected_sha256):
                installer_utils.cleanup_installer(temp_installer_path, force=True)
                raise Exception("Checksum verification FAILED - installer may be corrupted or tampered. Update aborted.")
            logging.info("[OK] Checksum verification passed")

            logging.info("Installer verified successfully")

            # Rewritten now that there is a verified installer to name,
            # which also starts the ten-minute staleness clock at the handoff
            # rather than at the download the guard already covers.
            self._write_update_marker(
                cmd_id, cmd_data, target_version, temp_installer_path)

            if self.firebase_client:
                self.firebase_client.update_command_progress(cmd_id, 'installing', deployment_id)

            if os_family == 'windows':
                return self._start_windows_update(temp_installer_path)
            return self._start_posix_update(
                temp_installer_path, os_family, update_marker_path)

        except Exception as e:
            # The "Error:" prefix is the whole command lane's failure
            # predicate, worker included - without it a refused artifact or a
            # failed checksum reads as a completed update.
            error_msg = f"Error: initiating update failed: {str(e)}"
            logging.error(error_msg)
            logging.exception("Update initiation failed")
            # Clean up marker on failure so we don't block future updates
            self._clear_update_marker(update_marker_path)
            return error_msg

    def _write_update_marker(self, cmd_id, cmd_data, target_version,
                             installer_path=None):
        """Record the update in progress, for the guard and for the next start.

        Written before the download so the idempotency guard brackets the whole
        operation, and again once there is a verified installer to name. It
        survives the restart the install causes; _check_update_status() reads
        it afterwards to report success or failure against this command.
        """
        marker = {
            'started_at': time.strftime('%Y-%m-%d %H:%M:%S'),
            'old_version': shared_utils.APP_VERSION,
            'target_version': target_version,
            'installer_url': cmd_data.get('installer_url'),
            'command_id': cmd_id,
            'deployment_id': cmd_data.get('deployment_id'),
        }
        if installer_path:
            marker['installer_path'] = installer_path

        marker_path = shared_utils.get_data_path('logs/update_in_progress.json')
        with open(marker_path, 'w') as f:
            json.dump(marker, f, indent=2)
        logging.debug(f"Update marker written: {marker_path}")

    def _update_staging_dir(self):
        """Where the update artifact is downloaded, verified and installed from.

        Under `cache/`, which decision 4's mode table keeps closed to the
        agent's group, and not the 0770 `tmp/` the desktop app shares: the
        package is checked by name and then handed to a root install by name,
        so anything that can write that directory - or rename it aside - can
        swap the artifact between the checksum and the install.
        """
        staging = shared_utils.get_data_path('cache/update')
        os.makedirs(staging, exist_ok=True)
        os.chmod(staging, 0o700)
        return staging

    def _check_update_disk_space(self):
        """Refuse an update the disk cannot hold.

        ~100MB installer plus ~200MB of extraction, with the old install still
        on disk.
        """
        import shutil

        data_root = shared_utils.get_data_path()
        drive = os.path.splitdrive(data_root)[0]
        target = drive + os.sep if drive else data_root
        free_mb = shutil.disk_usage(target).free / (1024 * 1024)
        logging.debug(f"Disk space on {target}: {free_mb:.0f} MB free")
        if free_mb < 500:
            raise Exception(
                f"Insufficient disk space: {free_mb:.0f} MB free, need at least "
                f"500 MB for safe update")

    def _clear_update_marker(self, update_marker_path):
        """Remove the in-progress marker; one left behind blocks every later update."""
        try:
            if os.path.exists(update_marker_path):
                os.remove(update_marker_path)
        except OSError as marker_err:
            logging.warning(f"Could not remove update marker: {marker_err}")

    def _start_posix_update(self, installer_path, os_family, update_marker_path):
        """Hand the package to the init system, or leave this version running.

        A refusal takes the marker with it: the installed version is still the
        one running, so leaving it would have the next start report a failed
        update and would block the retry the refusal is asking for.
        """
        started, detail = installer_utils.start_self_update(installer_path, os_family)
        if not started:
            self._clear_update_marker(update_marker_path)
            return f"Error: {detail}"
        return f"Self-update initiated: {detail}"

    def _start_windows_update(self, temp_installer_path):
        """Hand the installer to Task Scheduler and let it stop the service."""
        # Task Scheduler, so the installer survives Inno Setup killing
        # the service.
        log_path = shared_utils.get_data_path('logs/installer_update.log')
        # Inno Setup APPENDS to /LOG and every update refreshes the
        # mtime, so cleanup_old_logs never ages it out. Rotate here,
        # the last moment before the installer opens it.
        shared_utils.rotate_log_if_oversized(log_path)
        silent_flags = f'/VERYSILENT /NORESTART /SUPPRESSMSGBOXES /ALLUSERS /LOG="{log_path}"'
        task_name = f"OwletteUpdate_{int(time.time())}"

        logging.debug(f"Creating scheduled task: {task_name}")
        logging.debug(f"Installer flags: {silent_flags}")
        logging.debug(f"Installer log will be written to: {log_path}")

        schtasks_cmd = [
            'schtasks',
            '/Create',
            '/TN', task_name,
            '/TR', f'"{temp_installer_path}" {silent_flags}',
            '/SC', 'ONCE',
            '/ST', '00:00',
            '/RU', 'SYSTEM',
            '/RL', 'HIGHEST',
            '/F'
        ]

        result = subprocess.run(
            schtasks_cmd,
            capture_output=True,
            text=True,
            timeout=10
        )

        if result.returncode != 0:
            raise Exception(f"Failed to create scheduled task: {result.stderr}")

        logging.debug(f"Scheduled task created: {task_name}")

        run_result = subprocess.run(
            ['schtasks', '/Run', '/TN', task_name],
            capture_output=True,
            text=True,
            timeout=10
        )

        if run_result.returncode != 0:
            logging.warning(f"Task run command returned: {run_result.stderr}")
        else:
            logging.info("Installer task started successfully")

        # Watchdog: after 5 min, `net start` the service if the update
        # left it down. Start-Sleep keeps the delay non-interactive.
        recovery_task_name = f"OwletteRecovery_{int(time.time())}"
        recovery_cmd = (
            f'powershell -NoProfile -Command "Start-Sleep 300" && '
            f'sc query OwletteService | findstr "RUNNING" > nul || '
            f'(net start OwletteService & '
            f'schtasks /Delete /TN "{recovery_task_name}" /F)'
        )
        try:
            subprocess.run(
                ['schtasks', '/Create',
                 '/TN', recovery_task_name,
                 '/TR', f'cmd /c {recovery_cmd}',
                 '/SC', 'ONCE', '/ST', '00:00',
                 '/RU', 'SYSTEM', '/RL', 'HIGHEST', '/F'],
                capture_output=True, text=True, timeout=10
            )
            subprocess.run(
                ['schtasks', '/Run', '/TN', recovery_task_name],
                capture_output=True, text=True, timeout=10
            )
            logging.info(f"Recovery watchdog scheduled: {recovery_task_name} (will check service in ~5 min)")
        except Exception as recovery_err:
            logging.warning(f"Failed to create recovery watchdog (non-fatal): {recovery_err}")

        cleanup_proc = subprocess.Popen(
            ['cmd', '/c',
             f'powershell -NoProfile -Command "Start-Sleep 300" && '
             f'schtasks /Delete /TN "{task_name}" /F && '
             f'schtasks /Delete /TN "{recovery_task_name}" /F'],
            shell=False,
            creationflags=0x00000008,  # DETACHED_PROCESS
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL
        )
        del cleanup_proc  # Release Popen handle — process runs detached

        logging.debug("Installer will handle service restart automatically")
        logging.debug("Recovery watchdog will attempt restart if service doesn't come back")
        logging.debug("="*60)

        return "Self-update initiated via Task Scheduler"

    def _check_update_status(self):
        """
        Check if a self-update was in progress when the service started.
        This helps diagnose whether updates are completing successfully.
        Also detects stale markers from updates that never completed (crash, power loss, etc.)
        """
        try:
            update_marker_path = shared_utils.get_data_path('logs/update_in_progress.json')

            if not os.path.exists(update_marker_path):
                return  # No update was in progress

            logging.info("=" * 60)
            logging.info("UPDATE STATUS CHECK")
            logging.info("=" * 60)

            with open(update_marker_path, 'r') as f:
                marker = json.load(f)

            old_version = marker.get('old_version', 'unknown')
            target_version = marker.get('target_version', 'unknown')
            started_at = marker.get('started_at', 'unknown')
            current_version = shared_utils.APP_VERSION

            logging.info(f"Update started at: {started_at}")
            logging.info(f"Old version: {old_version}")
            logging.info(f"Target version: {target_version}")
            logging.info(f"Current version: {current_version}")

            # Stale markers from updates that never completed (power loss, BSOD,
            # killed installer).
            marker_age_minutes = float('inf')
            try:
                marker_time = datetime.datetime.strptime(started_at, '%Y-%m-%d %H:%M:%S')
                marker_age_minutes = (datetime.datetime.now() - marker_time).total_seconds() / 60
                logging.info(f"Update marker age: {marker_age_minutes:.1f} minutes")
            except (ValueError, TypeError):
                logging.warning(f"Could not parse marker timestamp: {started_at}")

            command_id = marker.get('command_id')
            deployment_id = marker.get('deployment_id')

            if current_version == target_version:
                logging.info("[SUCCESS] Self-update completed successfully!")
                self._pending_update_event = ('update_success', f'updated owlette agent from v{old_version} to v{current_version}', 'info')
                self._pending_update_completion = ('completed', command_id, deployment_id, f'updated to v{current_version}')
            elif current_version == old_version:
                logging.error(f"[FAILED] Self-update FAILED - still on version {old_version}")
                logging.error("Check installer_update.log for details")
                if marker_age_minutes > 30:
                    logging.error(f"Marker is {marker_age_minutes:.0f}m old - update likely crashed or hung")
                self._pending_update_event = ('update_failed', f'failed to update owlette agent from v{old_version} to v{target_version}', 'error')
                self._pending_update_completion = ('failed', command_id, deployment_id, f'still on v{old_version}, target was v{target_version}')
            else:
                logging.warning(f"[PARTIAL?] Unexpected version {current_version} after update")
                logging.warning(f"Expected {target_version}, was {old_version}")
                self._pending_update_event = ('update_unknown', f'unexpected version v{current_version} after update from v{old_version}', 'warning')
                self._pending_update_completion = ('completed', command_id, deployment_id, f'Updated to {current_version} (expected {target_version})')

            logging.info("=" * 60)

            try:
                os.remove(update_marker_path)
                logging.info("Update marker file cleaned up")
            except Exception as e:
                logging.warning(f"Failed to remove update marker: {e}")

            # ANTI-FRAGILE: Clean up any leftover recovery/update scheduled tasks
            try:
                result = subprocess.run(
                    ['schtasks', '/Query', '/FO', 'LIST'],
                    capture_output=True, text=True, timeout=10
                )
                if result.returncode == 0:
                    for task_match in re.finditer(r'(OwletteUpdate_\d+|OwletteRecovery_\d+)', result.stdout):
                        stale_task = task_match.group(1)
                        logging.info(f"Cleaning up leftover scheduled task: {stale_task}")
                        subprocess.run(
                            ['schtasks', '/Delete', '/TN', stale_task, '/F'],
                            capture_output=True, text=True, timeout=10
                        )
            except Exception as task_err:
                logging.debug(f"Task cleanup (non-fatal): {task_err}")

        except Exception as e:
            logging.warning(f"Error checking update status: {e}")
            # An unreadable marker would block every future update.
            try:
                update_marker_path = shared_utils.get_data_path('logs/update_in_progress.json')
                if os.path.exists(update_marker_path):
                    os.remove(update_marker_path)
                    logging.info("Cleaned up unreadable update marker")
            except OSError as marker_err:
                logging.warning(f"Could not remove update marker during cleanup: {marker_err}")

    def _migrate_legacy_roost_cache(self):
        """
        one-time migration: remove the legacy roost cache that earlier agent
        builds wrote under `C:\\Windows\\System32\\config\\systemprofile\\Documents\\Owlette\\`.

        background: pre-2.9.x versions of sync_downloader / sync_state / etc.
        resolved `~/Documents/Owlette/...` at runtime. under LocalSystem, `~`
        expands to the systemprofile directory, so the chunk cache + state DB
        lived inside System32 — invisible to operators and unreachable without
        elevation. we moved those caches to `%PROGRAMDATA%\\Owlette\\` in
        2.9.x; this migration deletes the System32-resident leftovers so they
        don't grow indefinitely.

        the cache is REBUILDABLE from R2 — chunks re-download on the next
        sync, state.db is recreated on first SyncState() construction,
        versions re-fetch. we intentionally DELETE rather than move: the
        user's explicit ask is that only actual files live under the extract
        location, and the new cache lives on a different drive anyway
        (ProgramData vs user profile in System32).

        gated by a one-shot flag file at `%PROGRAMDATA%\\Owlette\\.migrations\\content-store-moved`
        so we don't walk the legacy tree every boot.
        """
        if os.name != 'nt':
            return  # legacy layout only exists on windows LocalSystem

        flag_dir = shared_utils.get_data_path('.migrations')
        flag_path = os.path.join(flag_dir, 'content-store-moved')
        if os.path.exists(flag_path):
            return  # already migrated on a prior boot

        system_profile = os.environ.get(
            'SystemRoot', 'C:\\Windows'
        ).rstrip('\\') + '\\System32\\config\\systemprofile'
        legacy_content = os.path.join(
            system_profile, 'Documents', 'Owlette', '.owlette-content'
        )
        legacy_sync = os.path.join(
            system_profile, 'Documents', 'Owlette', '.owlette-sync'
        )

        def _count_and_size(root):
            """return (file_count, total_bytes). returns (0, 0) if root missing."""
            count, size = 0, 0
            if not os.path.isdir(root):
                return count, size
            for dirpath, _dirs, files in os.walk(root):
                for name in files:
                    try:
                        size += os.path.getsize(os.path.join(dirpath, name))
                        count += 1
                    except OSError:
                        pass
            return count, size

        import shutil

        any_removed = False
        for legacy_path in (legacy_content, legacy_sync):
            if not os.path.isdir(legacy_path):
                continue
            count, size = _count_and_size(legacy_path)
            gb = size / (1024 ** 3)
            logging.info(
                f"migration: removing legacy roost cache at {legacy_path!r} "
                f"({count} files, {gb:.2f} GB)"
            )
            try:
                shutil.rmtree(legacy_path, ignore_errors=False)
                any_removed = True
                logging.info(
                    f"migration: removed legacy cache {legacy_path!r} "
                    f"({count} files, {gb:.2f} GB freed)"
                )
            except OSError as e:
                # Best-effort, but deliberately does NOT write the flag on failure
                # so the next boot retries — a stuck 100GB cache in System32 is
                # the whole point of this migration.
                logging.warning(
                    f"migration: failed to remove {legacy_path!r}: {e}; "
                    f"will retry on next service start"
                )
                return

        # One-shot flag: reaching here means everything was cleaned or never
        # existed, so don't walk the tree again.
        try:
            os.makedirs(flag_dir, exist_ok=True)
            with open(flag_path, 'w') as f:
                f.write(
                    f"legacy roost cache migrated at {datetime.datetime.now().isoformat()}\n"
                )
            if any_removed:
                logging.info(f"migration: flag written at {flag_path!r}")
        except OSError as e:
            logging.warning(
                f"migration: could not write migration flag at {flag_path!r}: {e}; "
                f"migration will retry on next boot (idempotent — paths no longer exist)"
            )

    # Per-launch tasks from agents older than 2.1.1, which launched through Task
    # Scheduler. Their delete sat on a path exceptions skipped, so old boxes
    # accumulate them. Anchored full-name matches — both shapes are Owlette-only:
    #   OwletteProcess_<uuid>_<epoch>  2.0.26-2.0.54 (schtasks CLI)
    #   Owlette_Launch_<helper pid>    2.0.56 (Task Scheduler COM)
    LEGACY_LAUNCH_TASK_PATTERNS = (
        re.compile(r'^OwletteProcess_[0-9a-fA-F-]{8,36}_\d{9,11}$'),
        re.compile(r'^Owlette_Launch_\d+$'),
    )

    def _sweep_legacy_launch_tasks(self):
        """One-time removal of per-launch scheduled tasks left by pre-2.1.1 agents.

        These are inert — the COM-created ones carry no trigger at all and the
        schtasks-created ones a single one-time trigger dated to their creation
        day — so this is hygiene, not a live-fire fix: they clutter Task
        Scheduler and get mistaken for a second Owlette autostart.

        Deliberately narrow, because deleting a task an operator created would
        be far worse than leaving litter:
          * anchored full-name match on the two generated shapes only. A
            prefix match would take `Owlette_Test_*` and anything else a
            technician named Owlette-something.
          * never `OwletteUpdate_*` / `OwletteRecovery_*` — those are current,
            and one may be mid-flight right now. The post-update handler owns
            those and reaps them on its own path.
          * a task must have no trigger, or exactly one non-repeating trigger
            whose start boundary is in the past. Anything with a live trigger
            did not come from these code paths; it is logged and left alone.

        Gated by a one-shot flag file next to the roost-cache migration.
        """
        if os.name != 'nt':
            return

        flag_dir = shared_utils.get_data_path('.migrations')
        flag_path = os.path.join(flag_dir, 'legacy-launch-tasks-swept')
        if os.path.exists(flag_path):
            return

        def _is_inert(task_name):
            """True if the task can never fire on its own again.

            Reads the task's XML rather than trusting the name: the name tells
            us Owlette generated it, this tells us removing it is safe.
            """
            try:
                result = subprocess.run(
                    ['schtasks', '/Query', '/TN', task_name, '/XML', 'ONE'],
                    capture_output=True, text=True, timeout=10,
                    creationflags=subprocess.CREATE_NO_WINDOW,
                )
                if result.returncode != 0 or not result.stdout.strip():
                    return False
                import xml.etree.ElementTree as ET
                root = ET.fromstring(result.stdout)
                ns = {'t': 'http://schemas.microsoft.com/windows/2004/02/mit/task'}
                triggers = root.find('t:Triggers', ns)
                if triggers is None or len(triggers) == 0:
                    return True  # demand-start only — the COM-created shape
                if len(triggers) > 1:
                    return False
                trigger = triggers[0]
                # A repeating trigger fires again regardless of start date.
                if trigger.find('t:Repetition', ns) is not None:
                    return False
                enabled = trigger.find('t:Enabled', ns)
                if enabled is not None and (enabled.text or '').strip().lower() == 'false':
                    return True
                boundary = trigger.find('t:StartBoundary', ns)
                if boundary is None or not (boundary.text or '').strip():
                    return False
                start = datetime.datetime.fromisoformat(boundary.text.strip())
                if start.tzinfo is not None:
                    start = start.replace(tzinfo=None)
                return start < datetime.datetime.now()
            except Exception as e:
                logging.debug(f"legacy task sweep: could not inspect {task_name}: {e}")
                return False

        removed, skipped = 0, 0
        try:
            result = subprocess.run(
                ['schtasks', '/Query', '/FO', 'LIST'],
                capture_output=True, text=True, timeout=30,
                creationflags=subprocess.CREATE_NO_WINDOW,
            )
            if result.returncode != 0:
                logging.debug("legacy task sweep: schtasks query failed - will retry next start")
                return

            seen = set()
            for line in result.stdout.splitlines():
                if not line.lower().startswith('taskname:'):
                    continue
                # "TaskName: \Owlette_Launch_40320" — tasks live at the root.
                name = line.split(':', 1)[1].strip().lstrip('\\')
                if not name or name in seen:
                    continue
                seen.add(name)
                if not any(p.match(name) for p in self.LEGACY_LAUNCH_TASK_PATTERNS):
                    continue
                if not _is_inert(name):
                    logging.info(
                        f"legacy task sweep: leaving '{name}' in place - it has a "
                        f"live trigger, so it did not come from the legacy launcher"
                    )
                    skipped += 1
                    continue
                delete = subprocess.run(
                    ['schtasks', '/Delete', '/TN', name, '/F'],
                    capture_output=True, text=True, timeout=10,
                    creationflags=subprocess.CREATE_NO_WINDOW,
                )
                if delete.returncode == 0:
                    logging.info(f"legacy task sweep: removed stale launch task '{name}'")
                    removed += 1
                else:
                    logging.warning(
                        f"legacy task sweep: could not remove '{name}': "
                        f"{(delete.stderr or '').strip()}"
                    )
                    skipped += 1
        except Exception as e:
            # Never block service start on housekeeping. No flag is written,
            # so the next start retries.
            logging.warning(f"legacy task sweep failed (non-fatal): {e}")
            return

        if removed or skipped:
            logging.info(
                f"legacy task sweep complete: {removed} removed, {skipped} left in place")

        try:
            os.makedirs(flag_dir, exist_ok=True)
            with open(flag_path, 'w') as f:
                f.write(
                    f"legacy launch tasks swept at {datetime.datetime.now().isoformat()} "
                    f"({removed} removed, {skipped} skipped)\n"
                )
        except OSError as e:
            logging.warning(
                f"legacy task sweep: could not write flag at {flag_path!r}: {e}; "
                f"will re-run next start (idempotent — the tasks are already gone)"
            )

    def main(self):

        # The token ladder is Windows': off Windows the adapter spawns into
        # the console user's session and there is no token to hold.
        self.console_user_token = None
        self.environment = None
        self._last_logged_session_id = None
        if sys.platform == 'win32':
            # LocalSystem is assigned these but the child can inherit them
            # disabled, so enable them before the first token acquisition.
            self._enable_privileges()
            # Refreshed before every launch via _refresh_user_token() to
            # survive logout/login, RDP and user switches.
            self._refresh_user_token()

        # Tray icon launch tracking — avoid thrashing (crash-relaunch loops)
        self._tray_last_launch_time = 0
        self._tray_launch_cooldown = 30  # seconds between launch attempts

        # Cortex (local AI agent) launch tracking
        self._cortex_last_launch_time = 0
        self._cortex_launch_cooldown = 30

        # Before Firebase init, which can take seconds — the user needs immediate
        # feedback that the service is starting.
        self._try_launch_tray()

        logging.info("Service initialization complete")
        # WMI + GPU-driver backed, seconds on a cold driver, and log-only — so it
        # runs on a daemon thread and the startup path never waits on it.
        try:
            threading.Thread(
                target=shared_utils.log_startup_system_snapshot,
                name='startup-snapshot',
                daemon=True,
            ).start()
        except Exception as e:
            logging.warning(f"Could not start system snapshot thread (non-fatal): {e}")
        shared_utils.log_startup_config_summary()

        self._check_update_status()

        # Pre-2.9.x roost cache under the LocalSystem System32 profile.
        # Flag-file gated, idempotent.
        try:
            self._migrate_legacy_roost_cache()
        except Exception as e:
            logging.warning(f"Legacy roost cache migration errored (non-fatal): {e}")

        # Deliberately NOT gated on the update marker — these predate any 3.0.0
        # self-update, so an upgraded box would keep them forever. Flag-file
        # gated, idempotent.
        try:
            self._sweep_legacy_launch_tasks()
        except Exception as e:
            logging.warning(f"Legacy launch-task sweep errored (non-fatal): {e}")

        # Detects BSODs, crashes and out-of-band reboots; queues the warning in
        # _pending_anomaly_event until Firebase connects, and writes the fresh
        # session_state.json baseline that later intent writes mutate.
        self._classify_startup_session()

        # Service-log visibility only — Firestore submission waits for connect.
        try:
            pending = watchdog_state.read_pending_history()
            for entry in pending:
                shared_utils.log_watchdog_restart_replay(entry)
        except Exception as e:
            logging.debug(f"watchdog restart replay skipped (non-fatal): {e}")

        if self.firebase_client:
            try:
                self.firebase_client.register_command_callback(self.handle_firebase_command)

                self.firebase_client.register_config_update_callback(self.handle_config_update)

                # Before the config sync, which routinely takes 15s: until this
                # runs the status file says disconnected and the tray shows a red
                # badge on an already-connected machine.
                self._wire_connection_status_listener()

                # Sync config: pull from Firestore (source of truth), or seed if new machine
                sync_result = self.firebase_client.sync_config_on_startup()
                logging.info(f"Config sync on startup: {sync_result}")

                self.firebase_client.connection_manager.set_health_callback(
                    lambda code, msg: self._update_health_state('connection_failure', code, msg)
                )

                # Wire self-restart watchdog callback BEFORE start() so the
                # watchdog thread (spawned by start) always has one registered.
                self.firebase_client.connection_manager.set_restart_callback(
                    self._handle_watchdog_restart
                )

                # Only now: Firestore already holds our config and the hash is set,
                # so the config listener can't echo our own write back.
                _t0 = time.time()
                self.firebase_client.start()
                logging.info(f"Firebase client started successfully  ({round(time.time() - _t0, 3)}s)")

                # Cache site timezone for schedule evaluation
                self._cached_site_timezone = self.firebase_client.site_timezone

                if hasattr(self, '_pending_update_event') and self._pending_update_event:
                    event_type, message, level = self._pending_update_event
                    try:
                        self.firebase_client.log_event(event_type, level, details=message)
                        logging.info(f"Update event logged to Firebase: {event_type}")
                    except Exception as e:
                        logging.warning(f"Failed to log update event to Firebase: {e}")
                    self._pending_update_event = None

                if getattr(self, '_pending_anomaly_event', None):
                    anomaly_action, anomaly_details = self._pending_anomaly_event
                    try:
                        self.firebase_client.log_event(
                            action=anomaly_action,
                            level='warning',
                            details=anomaly_details,
                        )
                        logging.info(f"Startup anomaly event logged to Firebase: {anomaly_action}")
                        self._pending_anomaly_event = None
                    except Exception as e:
                        logging.warning(f"Failed to log startup anomaly event to Firebase: {e}")

                self._flush_pending_watchdog_events()

                if hasattr(self, '_pending_update_completion') and self._pending_update_completion:
                    status, cmd_id, deployment_id, result_msg = self._pending_update_completion
                    if cmd_id:
                        try:
                            if status == 'completed':
                                self.firebase_client._mark_command_completed(cmd_id, result_msg, deployment_id, 'update_owlette')
                                if deployment_id:
                                    self.firebase_client.log_event('deployment_completed', 'info', 'owlette Update',
                                                                   f"Deployment {deployment_id}: {result_msg}")
                            else:
                                self.firebase_client._mark_command_failed(cmd_id, result_msg, deployment_id, 'update_owlette')
                                if deployment_id:
                                    self.firebase_client.log_event('deployment_failed', 'error', 'owlette Update',
                                                                   f"Deployment {deployment_id} failed: {result_msg}")
                            logging.info(f"Update command {cmd_id} marked as {status} in Firestore")
                        except Exception as e:
                            logging.warning(f"Failed to report update completion to Firestore: {e}")
                    self._pending_update_completion = None

                # Register atexit handler to ensure machine is marked offline even if killed abruptly
                def emergency_offline_handler():
                    """Emergency handler to mark machine offline if service is killed without proper shutdown"""
                    try:
                        if self.firebase_client and self.firebase_client.connected:
                            logging.warning("EMERGENCY CLEANUP: Marking machine offline")
                            self.firebase_client._update_presence(False)
                            logging.debug("Emergency offline update sent")
                    except Exception as e:
                        logging.debug(f"Emergency offline handler error (shutting down): {e}")

                atexit.register(emergency_offline_handler)
                logging.debug("Emergency offline handler registered")

                shared_utils.add_firebase_log_handler(self.firebase_client)

            except Exception as e:
                logging.error(f"Error starting Firebase client: {e}")

        logging.debug("Checking for processes from previous session...")
        self.recover_running_processes()

        # Clear stale reboot/shutdown flags from previous session (e.g., after a completed reboot)
        if self.firebase_client and self.firebase_client.is_connected():
            try:
                # One write clearing the countdown anchors too, so the dashboard
                # pill drops on the first listener tick after reconnect.
                self.firebase_client.set_machine_flags({
                    'rebooting': False,
                    'shuttingDown': False,
                    'rebootScheduledAt': None,
                    'shutdownScheduledAt': None,
                    'rebootCancellable': False,
                    'rebootSource': None,
                    'rebootEntryId': None,
                })
                self.firebase_client.clear_reboot_pending()
                logging.info("Cleared stale reboot/shutdown flags on startup")
            except Exception as e:
                logging.warning(f"Failed to clear stale flags on startup: {e}")

        self._detect_reboot_success_on_startup()

        # A sentinel present at startup means the previous watchdog thread is
        # dead, so revert immediately regardless of deadline — an unacknowledged
        # apply must never survive.
        try:
            import display_manager

            sentinel_path = shared_utils.get_data_path('.display_revert_pending')
            if os.path.exists(sentinel_path):
                logging.warning(
                    f"Found stale display revert sentinel at {sentinel_path} — "
                    "previous apply did not complete cleanly, reverting"
                )
                apply_revert = getattr(display_manager, 'apply_revert_from_sentinel', None)
                if callable(apply_revert):
                    try:
                        # Pass firebase_client so the no-console-session deferral
                        # path (Wave 5) can emit `display_revert_deferred`.
                        result = apply_revert(firebase_client=self.firebase_client)
                        logging.info(f"Display revert from sentinel: {result}")
                    except Exception as revert_err:
                        logging.error(f"Display revert from sentinel failed: {revert_err}")
                        # Still try to delete the sentinel so we don't loop on next start.
                        try:
                            os.remove(sentinel_path)
                        except OSError as rm_err:
                            logging.warning(f"Failed to delete stale display sentinel: {rm_err}")
                else:
                    logging.warning(
                        "display_manager.apply_revert_from_sentinel not available; "
                        "deleting sentinel without revert"
                    )
                    try:
                        os.remove(sentinel_path)
                    except OSError as rm_err:
                        logging.warning(f"Failed to delete stale display sentinel: {rm_err}")
        except Exception as e:
            logging.warning(f"Display sentinel check failed: {e}")

        cleanup_counter = 0  # Counter for periodic cleanup
        log_cleanup_counter = 0  # Counter for log cleanup (runs less frequently)
        firebase_check_counter = 0  # Counter for Firebase state check (runs every minute)
        reboot_pending_counter = 0  # Counter for reboot-pending check (runs every 15 min)
        last_firebase_state = {
            'enabled': self.firebase_client is not None,
            'site_id': shared_utils.read_config(['firebase', 'site_id']) if self.firebase_client else None
        }

        _total = round(time.time() - self._service_start_time, 2)
        if self.firebase_client and self.firebase_client.is_connected():
            _fb_status = "connected"
        elif self.firebase_client:
            _fb_status = "offline (client initialized, not connected)"
        else:
            _fb_status = "disabled" if not shared_utils.read_config(['firebase', 'enabled']) else "failed to initialize"
        _proc_count = len(shared_utils.read_config(['processes']) or [])
        _sep = "=" * 70
        logging.info(_sep)
        logging.info("  STARTUP COMPLETE")
        logging.info(_sep)
        logging.info(f"  Version          : {shared_utils.APP_VERSION}")
        logging.info(f"  Total startup    : {_total}s")
        logging.info(f"  Firebase         : {_fb_status}")
        logging.info(f"  Processes        : {_proc_count} configured")
        logging.info(_sep)
        # Its own thread, not the 5s loop: a desktop-app edit is operator-facing
        # and should reach the dashboard in a second or two, not wait out a tick.
        try:
            self.start_local_config_watcher()
        except Exception as e:
            logging.error(f"Failed to start the local config watcher: {e}")

        logging.info("Starting main service loop...")

        try:
            while self.is_alive:
                # There is deliberately no "shutdown flag": the desktop app's
                # "quit owlette" is an elevated SCM stop. A flag was tried and
                # failed — the supervisor relaunches any non-clean exit.

                # Exit 42 makes the host relaunch us; exit 0 would stop the
                # service (agent/host/src/supervisor.rs).
                restart_flag = shared_utils.get_data_path('tmp/restart.flag')
                if self._restart_requested(restart_flag):
                    logging.info("Restart flag detected — exiting for a host restart")
                    try:
                        os.remove(restart_flag)
                    except Exception as e:
                        logging.debug(f"Could not remove restart flag: {e}")
                    # Mark this restart as Owlette-initiated so the next startup
                    # classifier treats it as planned and stays silent.
                    try:
                        session_state.set_intent("owlette_service_restart")
                    except Exception as e:
                        logging.debug(f"session_state.set_intent failed in restart flag: {e}")
                    self._restart_exit_code = 42
                    self.is_alive = False
                    break

                # last_alive feeds the next startup classifier's "last seen alive
                # → boot" gap; redundant with the metrics-thread heartbeat.
                try:
                    session_state.update_alive()
                except Exception as e:
                    logging.debug(f"session_state.update_alive failed: {e}")

                self._try_launch_tray()

                self._try_launch_cortex()

                self._process_cortex_ipc_commands()

                self._process_privileged_requests()

                # A plain attribute read — the client refreshes it every 900s on
                # the metrics thread, so nothing here blocks the 5s tick. Without
                # this the value stayed frozen at whatever connect saw, and a site
                # opting in or out of site-time schedules needed a service restart
                # to take effect.
                if self.firebase_client:
                    self._cached_site_timezone = self.firebase_client.site_timezone

                self.current_time = datetime.datetime.now()

                content = shared_utils.read_json_from_file(shared_utils.RESULT_FILE_PATH)
                if content is None:
                    content = {}
                if content:
                    self.results = content
                else:
                    self.results = {}

                processes = shared_utils.read_config(['processes']) or []
                self._diff_and_apply_launch_modes(processes)
                for process in processes:
                    mode = self._get_process_launch_mode(process)
                    if mode == 'always':
                        self.handle_process(process)
                    elif mode == 'scheduled':
                        process_id = process.get('id')
                        schedules = process.get('schedules')
                        in_window = shared_utils.is_within_schedule(schedules, self._cached_site_timezone)
                        has_override = process_id in self.manual_overrides

                        if in_window:
                            if has_override:
                                del self.manual_overrides[process_id]
                            self.handle_process(process)
                        else:
                            if has_override:
                                # Manual override active — keep processing (don't kill)
                                self.handle_process(process)
                            else:
                                last_info = self.last_started.get(process_id, {})
                                last_pid = last_info.get('pid')
                                if last_pid and not last_info.get('failed'):
                                    # Identity-gated, and through
                                    # graceful_terminate with exe_path --
                                    # never a raw psutil terminate. See
                                    # _stop_process_outside_window.
                                    _stop_process_outside_window(self, process, last_pid)
                    else:
                        # Off: not watched, but an operator restart still means
                        # restart. Nothing else here touches an off process.
                        self._relaunch_if_restarting(process)

                # Every REBOOT_CHECK_INTERVAL_SECONDS, derived from SLEEP_INTERVAL.
                self._reboot_schedule_counter += 1
                if self._reboot_schedule_counter >= REBOOT_CHECK_ITERATIONS:
                    self._reboot_schedule_counter = 0
                    self._check_scheduled_reboot()

                # Logs real topology changes only; the Firestore upload rides the
                # firebase_client metrics loop, not this path.
                self._display_check_counter += 1
                if self._display_check_counter >= DISPLAY_CHECK_ITERATIONS:
                    self._display_check_counter = 0
                    self._check_display_topology()

                # Hourly, single-flight, on a daemon thread; one SQL query when
                # nothing is due.
                self._roost_scrub_check_counter += 1
                if self._roost_scrub_check_counter >= ROOST_SCRUB_CHECK_ITERATIONS:
                    self._roost_scrub_check_counter = 0
                    self._maybe_dispatch_roost_scrub()

                if self.first_start:
                    logging.info('owlette initialized')

                    if self.firebase_client and self.firebase_client.is_connected():
                        try:
                            version = shared_utils.get_app_version()
                            self.firebase_client.log_event(
                                action='agent_started',
                                level='info',
                                process_name=None,
                                details=f'owlette agent v{version} started successfully'
                            )
                            logging.debug("Logged agent_started event to Firestore")
                        except Exception as log_err:
                            logging.error(f"Failed to log agent_started event: {log_err}")

                        # Backup: the primary emission near firebase_client.start()
                        # is skipped when Firebase isn't connected yet.
                        if getattr(self, '_pending_anomaly_event', None):
                            anomaly_action, anomaly_details = self._pending_anomaly_event
                            try:
                                self.firebase_client.log_event(
                                    action=anomaly_action,
                                    level='warning',
                                    details=anomaly_details,
                                )
                                logging.info(
                                    f"Startup anomaly event logged to Firebase (deferred): {anomaly_action}"
                                )
                                self._pending_anomaly_event = None
                            except Exception as log_err:
                                logging.error(
                                    f"Failed to log startup anomaly event (deferred): {log_err}"
                                )

                        # Same retry for watchdog-restart events.
                        self._flush_pending_watchdog_events()

                self.first_start = False

                # Catches Firebase being re-enabled from the GUI or a config edit.
                firebase_check_counter += 1
                if firebase_check_counter >= 2:
                    try:
                        current_firebase_enabled = shared_utils.read_config(['firebase', 'enabled'])
                        current_site_id = shared_utils.read_config(['firebase', 'site_id'])
                        current_firebase_state = {
                            'enabled': current_firebase_enabled and current_site_id is not None,
                            'site_id': current_site_id
                        }

                        was_enabled = last_firebase_state['enabled']
                        is_enabled = current_firebase_state['enabled']
                        old_site_id = last_firebase_state['site_id']
                        new_site_id = current_firebase_state['site_id']

                        # Case 1: Firebase was disabled and is now enabled
                        if not was_enabled and is_enabled:
                            logging.debug("=" * 60)
                            logging.info("FIREBASE RE-ENABLED DETECTED (via local config change)")
                            logging.debug(f"Site ID: {new_site_id}")
                            logging.debug("Reinitializing Firebase client...")
                            logging.debug("=" * 60)

                            success = self._initialize_or_restart_firebase_client()
                            if success:
                                logging.info("[OK] Firebase client restarted successfully")
                                last_firebase_state = current_firebase_state
                            else:
                                logging.error("[ERROR] Failed to restart Firebase client")

                        # Case 2: Site ID changed while Firebase was enabled
                        elif was_enabled and is_enabled and old_site_id != new_site_id:
                            logging.debug("=" * 60)
                            logging.info(f"SITE ID CHANGE DETECTED: {old_site_id} -> {new_site_id}")
                            logging.debug("Reinitializing Firebase client for new site...")
                            logging.debug("=" * 60)

                            success = self._initialize_or_restart_firebase_client()
                            if success:
                                logging.info("[OK] Firebase client restarted for new site")
                                last_firebase_state = current_firebase_state
                            else:
                                logging.error("[ERROR] Failed to restart Firebase client for new site")

                        # Case 3: Firebase was enabled and is now disabled
                        elif was_enabled and not is_enabled:
                            logging.info("Firebase has been DISABLED - stopping Firebase client")
                            if self.firebase_client:
                                try:
                                    self.firebase_client.stop()
                                    self.firebase_client = None
                                    logging.info("[OK] Firebase client stopped")
                                except Exception as e:
                                    logging.error(f"[ERROR] Failed to stop Firebase client: {e}")
                            last_firebase_state = current_firebase_state

                        # Enabled with a site but nothing serving it: reached when
                        # FirebaseClient construction or main()'s wiring threw.
                        # The config transitions above can't fire (nothing
                        # changed), so without this the machine stays cloud-dead
                        # until a restart. Failures arm a 5-minute hold.
                        elif is_enabled and not self._shutting_down and (
                            self.firebase_client is None
                            or not getattr(self.firebase_client, 'running', False)
                        ):
                            if time.monotonic() >= self._firebase_reinit_not_before:
                                logging.warning(
                                    "Firebase is enabled but no running client is serving it - "
                                    "attempting recovery reinitialization"
                                )
                                if self._initialize_or_restart_firebase_client():
                                    logging.info("[OK] Firebase client recovered")
                                    last_firebase_state = current_firebase_state
                                else:
                                    self._firebase_reinit_not_before = time.monotonic() + 300.0
                                    logging.error(
                                        "[ERROR] Firebase client recovery failed - next attempt in 300s"
                                    )

                    except Exception as e:
                        logging.error(f"Error checking Firebase state: {e}")

                    firebase_check_counter = 0

                # Periodic cleanup of stale tracking data (every 30 iterations = 5 minutes)
                cleanup_counter += 1
                if cleanup_counter >= 60:
                    self.cleanup_stale_tracking_data()
                    cleanup_counter = 0

                # Periodic cleanup of old log files (every 8640 iterations = 24 hours)
                # Reboot-pending check every 15 min (180 iterations at SLEEP_INTERVAL=5s)
                reboot_pending_counter += 1
                if reboot_pending_counter >= 180:
                    self._submit_reboot_pending_check()
                    reboot_pending_counter = 0

                log_cleanup_counter += 1
                if log_cleanup_counter >= 17280:
                    try:
                        max_age_days = shared_utils.read_config(['logging', 'max_age_days']) or 90
                        deleted_count = shared_utils.cleanup_old_logs(max_age_days)
                        if deleted_count > 0:
                            logging.debug(f"Daily log cleanup: {deleted_count} old log file(s) removed")
                    except Exception as e:
                        logging.error(f"Log cleanup failed: {e}")
                    log_cleanup_counter = 0

                # Write service status for tray icon (every loop iteration = 10s)
                self._write_service_status()

                time.sleep(SLEEP_INTERVAL)
        finally:
            # Marks the machine offline even when hosted by owlette-host.
            logging.warning("=== MAIN LOOP EXITING - PERFORMING CLEANUP ===")

            # graceful_shutdown() normally runs on the console-handler or SCM-
            # watcher thread, because the stop budget is bounded and this loop
            # can't be relied on to unwind in time. If it already ran, presence is
            # flushed and agent_stopped logged — repeating would double-log.
            already_shut_down = getattr(self, '_shutdown_trigger', None) is not None
            if already_shut_down:
                logging.info(
                    f"Cleanup: shutdown already performed by {self._shutdown_trigger}"
                )

            firebase_connected = self.firebase_client and self.firebase_client.is_connected()
            logging.info(f"Firebase client available: {self.firebase_client is not None}, connected: {firebase_connected}")

            # agent_stopped is logged by owlette_runner.py's signal handler, which
            # runs even on a fast kill — logging here would duplicate it.
            if firebase_connected:
                logging.info("Main loop exiting - agent_stopped will be logged by signal handler")
                # Give Firebase time to flush any pending writes
                time.sleep(0.5)
            else:
                logging.warning("Firebase client not available")

            # An Owlette-initiated restart (exit 42 tray, 43 watchdog) is
            # relaunched immediately, so skip the offline flush — otherwise every
            # restart flaps the dashboard. A real stop (exit 0) still goes offline.
            intentional_restart = bool(getattr(self, '_restart_exit_code', 0))
            if self.firebase_client and not already_shut_down:
                try:
                    logging.info(
                        "Stopping Firebase client for restart (presence left online)..."
                        if intentional_restart
                        else "Calling firebase_client.stop() to mark machine offline..."
                    )
                    self.firebase_client.stop(intentional=intentional_restart)
                    logging.info(
                        "[OK] Cleanup complete - restart pending, machine left online"
                        if intentional_restart
                        else "[OK] Cleanup complete - machine marked offline"
                    )
                except Exception as e:
                    logging.error(f"[ERROR] Error during cleanup: {e}")

            # The desktop app deliberately survives a service stop — its footer is
            # the operator's only way to start the service again.

            logging.info("Service cleanup complete - exiting")


if __name__ == '__main__':
    # The service verbs this module used to accept went with the pywin32
    # ServiceFramework; owlette-host is the service now. Exiting loudly keeps a
    # stale `owlette_service.py install|start|debug` from looking like a success.
    print(
        "owlette_service is a module, not an entry point - run "
        "`python owlette_runner.py --debug` to start the service loop.",
        file=sys.stderr,
    )
    sys.exit(2)
