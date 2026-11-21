"""
Reboot state persistence — local source of truth for the scheduled-reboot
state machine in owlette_service.py.

Stored at: C:\\ProgramData\\Owlette\\tmp\\reboot_state.json (alongside the
other agent runtime state files: app_states.json, service_status.json).

This file is the source of truth for the agent's own decisions:
  - lastFiredByEntry: per-entry "we already fired this day" dedup
  - attempt: in-progress attempt tracking (entry, status)
  - deferredReboot: a reboot held until active hours end (at, queuedBy,
    requestedAt; unix seconds), never an attempt: an attempt holds the
    connection watchdog off, and a deferral can wait for hours

Firestore receives a best-effort mirror at sites/{siteId}/machines/{machineId}.rebootState
for dashboard visibility (see firebase_client.mirror_reboot_state). The
deferral is shown by the machine's rebootDeferredUntil flag instead.

The local file is required so that the agent can dedup attempts even when
Firestore is unreachable — without it, an offline agent could re-fire the
same scheduled instant multiple times across service restarts.
"""

import json
import logging
import os

import shared_utils

STATE_PATH = shared_utils.get_data_path('tmp/reboot_state.json')


def read_state() -> dict:
    """Read reboot state from disk.

    Returns a dict with keys 'lastFiredByEntry', 'attempt' and
    'deferredReboot'. If the file is missing or corrupt, returns the empty
    state (and deletes the corrupt file so subsequent writes start clean).
    """
    if not os.path.exists(STATE_PATH):
        return _empty()

    try:
        with open(STATE_PATH, 'r') as f:
            data = json.load(f)
        # Validate shape — defensive normalization
        if not isinstance(data, dict):
            raise ValueError('reboot_state.json is not an object')
        last_fired = data.get('lastFiredByEntry', {})
        if not isinstance(last_fired, dict):
            last_fired = {}
        attempt = data.get('attempt')
        if attempt is not None and not isinstance(attempt, dict):
            attempt = None
        deferred = data.get('deferredReboot')
        if deferred is not None and not (
                isinstance(deferred, dict)
                and all(isinstance(deferred.get(k), (int, float)) for k in ('at', 'requestedAt'))):
            deferred = None
        return {
            'lastFiredByEntry': last_fired,
            'attempt': attempt,
            'deferredReboot': deferred,
        }
    except (json.JSONDecodeError, ValueError, OSError) as e:
        logging.warning(f"reboot_state.json is corrupt ({e}); resetting to empty state")
        try:
            os.remove(STATE_PATH)
        except OSError:
            pass
        return _empty()


def write_state(state: dict) -> bool:
    """Write reboot state to disk atomically. Returns True on success."""
    try:
        os.makedirs(os.path.dirname(STATE_PATH), exist_ok=True)
        # Write to a temp file then rename — atomic on Windows for same-volume renames.
        tmp_path = STATE_PATH + '.tmp'
        with open(tmp_path, 'w') as f:
            json.dump({
                'lastFiredByEntry': state.get('lastFiredByEntry', {}),
                'attempt': state.get('attempt'),
                'deferredReboot': state.get('deferredReboot'),
            }, f, indent=2)
        os.replace(tmp_path, STATE_PATH)
        return True
    except OSError as e:
        logging.error(f"Failed to write reboot_state.json: {e}")
        return False


def prune_orphaned_entries(state: dict, current_entry_ids: set) -> dict:
    """Remove lastFiredByEntry keys whose entry IDs no longer exist.

    Keeps the dedup map from growing unbounded as users edit/delete entries.
    Returns the (possibly modified) state — caller is responsible for writing.
    """
    last_fired = state.get('lastFiredByEntry', {})
    pruned = {k: v for k, v in last_fired.items() if k in current_entry_ids}
    if len(pruned) != len(last_fired):
        state['lastFiredByEntry'] = pruned
    return state


def clear_attempt(state: dict) -> dict:
    """Clear the in-progress attempt (used when schedule changes mid-attempt)."""
    state['attempt'] = None
    return state


def _empty() -> dict:
    return {
        'lastFiredByEntry': {},
        'attempt': None,
        'deferredReboot': None,
    }
