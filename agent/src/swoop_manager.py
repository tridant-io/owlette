"""swoop streamer lifecycle, owned by the agent service.

One streamer per machine serves every viewer. ``SwoopManager`` decides when it
runs, reads its stdout events and ends it. Everything it does happens on its own
threads: every public method hands work to a queue and returns, because the
service's main loop runs every ``SLEEP_INTERVAL = 5`` seconds and nothing here
may sit on it.

Spawn refusals are deliberate dead ends -- an unverified install, a version
mismatch, a crash loop or too many spawns in a window all stop swoop on this
machine rather than degrading it. Task 3.1 assigns the instance as
``service.swoop_manager``.
"""

import json
import logging
import os
import queue
import subprocess
import threading
import time

import shared_utils
import swoop_spawn

logger = logging.getLogger(__name__)

# stdout event names -- PROTOCOL.md section 6.
EVENT_READY = 'ready'
EVENT_VIEWER_JOINED = 'viewer_joined'
EVENT_VIEWER_LEFT = 'viewer_left'
EVENT_SAS_REQUEST = 'sas_request'
EVENT_HOST_EVENT = 'host_event'
EVENT_STATUS = 'status'
EVENT_EXITING = 'exiting'
EVENT_TOKEN_NEEDED = 'token_needed'
KNOWN_EVENTS = frozenset({
    EVENT_READY, EVENT_VIEWER_JOINED, EVENT_VIEWER_LEFT,
    EVENT_SAS_REQUEST, EVENT_HOST_EVENT, EVENT_STATUS, EVENT_EXITING,
    EVENT_TOKEN_NEEDED,
})
# a streamer that lost its room asks for a token every 20 s; one mint per ask
# is plenty, and this floor keeps a chatty streamer from turning into a mint storm.
TOKEN_ASK_MIN_INTERVAL_S = 5.0

STATE_IDLE = 'idle'
STATE_STARTING = 'starting'
STATE_RUNNING = 'running'
STATE_STOPPING = 'stopping'

# a crash costs one ladder step; a clean exit clears it. base is short because a
# single transient failure should not cost a viewer a minute, the cap is five
# minutes because past that the machine needs an operator, not a retry.
BACKOFF_BASE_S = 5
BACKOFF_MAX_S = 300
# and above the ladder, a hard ceiling: a streamer that dies fast enough to stay
# under the backoff is still a loop, so cap the spawns in a rolling window. a
# clean exit is a viewer leaving, not a loop, and does not count: a page that
# reconnected five times in six minutes used to lock the machine out of swoop
# for the rest of the window (b4a, 2026-09-25).
SPAWN_CEILING = 5
SPAWN_WINDOW_S = 600

# how long the streamer gets to act on the kill line before the job is closed.
KILL_GRACE_S = 5
# bounded so a consumer that stops draining cannot grow the agent's memory.
EVENT_QUEUE_MAX = 256
WORK_QUEUE_MAX = 32

# host events go to POST /api/agent/swoop/events, which takes 20 per batch. the
# queue is a few batches deep and drops the oldest when it fills: an audit row is
# worth less than the agent's memory, and it is never worth blocking the reader.
AUDIT_QUEUE_MAX = 100
AUDIT_BATCH_MAX = 20

# side effects -- the two machine-wide changes swoop needs, and the record that
# makes both of them reversible. the identities below are the ones the enable,
# the disable and the uninstaller all agree on; changing one changes three.
FIREWALL_RULE_NAME = 'Owlette-swoop-UDP-In'
FIREWALL_RULE_DISPLAY = 'Owlette swoop'
FIREWALL_MDNS_RULE_NAME = 'Owlette-swoop-mDNS-In'
FIREWALL_MDNS_RULE_DISPLAY = 'Owlette swoop (mDNS)'
# every rule carries the group, because deleting by group is what lets the
# uninstaller sweep them without knowing each name.
FIREWALL_GROUP = 'Owlette swoop'
MDNS_PORT = 5353

SAS_POLICY_KEY = r'SOFTWARE\Microsoft\Windows\CurrentVersion\Policies\System'
SAS_VALUE_NAME = 'SoftwareSASGeneration'
SAS_ENABLED_VALUE = 3
SAS_VALUE_MAX = 3
# the policy's unset state is a value in its own right: restoring "absent" as a
# zero would turn a policy nobody set into one explicitly disabled.
SAS_ABSENT = 'absent'

STATE_KEY_FIREWALL = 'firewall'
STATE_KEY_SAS_PRIOR = 'sasPrior'
SIDE_EFFECT_STATE_PATH = shared_utils.get_data_path('tmp/swoop_side_effects.json')

# generous: New-NetFirewallRule on a machine with a cold WMI/MI stack is slow,
# and this never runs on the service's loop.
POWERSHELL_TIMEOUT_S = 60

# the host's room token lives 300 s (PROTOCOL.md section 8) and the streamer
# holds no credential to mint its own, so a session used to end at the five
# minute mark: the service mints a fresh one a minute ahead and writes it to the
# streamer's stdin, which re-dials the room. the lifetime is the protocol's
# constant, not a bundle field -- the fielded streamer refuses a bundle with a
# key it does not know. a failed mint is retried while the token still lives.
TOKEN_TTL_DEFAULT_S = 300
TOKEN_REFRESH_LEAD_S = 60
TOKEN_REFRESH_RETRY_S = 20


class SwoopManager:
    """Runs and ends the swoop streamer. Every method returns immediately."""

    def __init__(self, firebase_client=None, on_refresh=None, spawn_backend=None):
        """``on_refresh`` is the doorbell's ``refresh_now``, wired by Task 3.1.

        Spike 0.6 gives ``swoop_refresh`` no other route to the doorbell:
        the command reaches :meth:`on_session_change`, which calls this.
        """
        self._firebase = firebase_client
        self._on_refresh = on_refresh
        self._spawn = spawn_backend or swoop_spawn

        self._lock = threading.Lock()
        self._proc = None
        self._sid = None
        self._state = STATE_IDLE
        self._viewers = set()
        self._controllers = set()
        self._last_status = {}
        self._last_refusal = None
        self._last_exit = None
        self._end_logged = True
        self._token_timer = None
        self._token_expires_at = 0.0
        self._token_minted_at = 0.0

        self._backoff_s = 0
        self._retry_after = 0.0
        self._spawn_times = []

        self._events = queue.Queue(maxsize=EVENT_QUEUE_MAX)
        self._work = queue.Queue(maxsize=WORK_QUEUE_MAX)
        self._audit = queue.Queue(maxsize=AUDIT_QUEUE_MAX)
        self._worker = None
        self._reader = None
        # its own thread, not the work queue: a post can sit on the network for
        # ten seconds, and a kill queued behind one is a session that outlives
        # its revocation.
        self._auditor = None

    # public surface

    def ensure_streamer(self, sid):
        """Ask for a running streamer for ``sid``. Returns without waiting."""
        self._submit(('ensure', sid))

    def kill(self, reason='kill'):
        """End the current session. Returns without waiting."""
        self._submit(('kill', reason))

    def set_enabled(self, enabled):
        """Apply or undo swoop's machine-wide side effects. Returns without waiting."""
        self._submit(('side_effects', bool(enabled)))

    def on_session_change(self):
        """A swoop session may have appeared or gone -- poke the doorbell."""
        if self._on_refresh is None:
            return
        try:
            self._on_refresh()
        except Exception as e:
            logger.warning('swoop: refresh callback failed: %s', e)

    def status(self):
        """A snapshot of manager state. Never touches the streamer."""
        with self._lock:
            return {
                'state': self._state,
                'sid': self._sid,
                'pid': self._proc.pid if self._proc else None,
                'viewers': len(self._viewers),
                'controllers': len(self._controllers),
                'lastRefusal': self._last_refusal,
                'lastExit': self._last_exit,
                'retryInS': max(0, int(self._retry_after - time.monotonic())),
                'streamer': dict(self._last_status),
            }

    def drain_events(self, max_items=64):
        """Pop up to ``max_items`` parsed stdout events. Never blocks."""
        drained = []
        for _ in range(max_items):
            try:
                drained.append(self._events.get_nowait())
            except queue.Empty:
                break
        return drained

    # worker

    def _submit(self, item):
        self._start_worker()
        try:
            self._work.put_nowait(item)
        except queue.Full:
            # the queue only fills if the worker is wedged; dropping beats blocking.
            logger.warning('swoop: work queue full, dropped %s', item[0])

    def _start_worker(self):
        with self._lock:
            if self._worker is not None and self._worker.is_alive():
                return
            self._worker = threading.Thread(
                target=self._worker_loop, name='swoop-manager', daemon=True,
            )
            self._worker.start()

    def _worker_loop(self):
        while True:
            action, payload = self._work.get()
            try:
                if action == 'ensure':
                    self._do_ensure(payload)
                elif action == 'kill':
                    self._do_kill(payload)
                elif action == 'side_effects':
                    self._do_side_effects(payload)
                elif action == 'token':
                    self._do_token(payload)
            except Exception as e:
                logger.error('swoop: %s failed: %s', action, e)

    # spawn path

    def _do_ensure(self, sid):
        with self._lock:
            running = self._proc is not None
            same_sid = running and self._sid == sid
        if same_sid:
            return
        if running:
            # one streamer per machine: a new sid replaces the old session.
            self._do_kill('session_change')

        refusal = self._spawn_gate()
        if refusal:
            self._refuse(refusal)
            return

        try:
            exe_path = self._spawn.verify_install()
        except swoop_spawn.SwoopSpawnError as e:
            self._refuse(e.reason, str(e))
            return

        with self._lock:
            self._state = STATE_STARTING
            self._sid = sid
            self._spawn_times.append(time.monotonic())

        try:
            bundle = self._spawn.fetch_bundle(
                sid, self._site_id(), self._machine_id(), self._auth_manager(),
            )
        except swoop_spawn.SwoopSpawnError as e:
            self._refuse(e.reason, str(e))
            return
        except Exception as e:
            self._refuse(swoop_spawn.REFUSAL_BUNDLE_UNAVAILABLE, str(e))
            return

        try:
            proc = self._spawn.spawn(exe_path)
        except swoop_spawn.SwoopSpawnError as e:
            bundle[:] = b'\x00' * len(bundle)
            self._refuse(e.reason, str(e))
            return
        except Exception as e:
            bundle[:] = b'\x00' * len(bundle)
            self._refuse(swoop_spawn.REFUSAL_SPAWN_FAILED, str(e))
            return

        try:
            proc.write_bundle(bundle)
        except Exception as e:
            # a streamer that never got its bundle must not be left running.
            bundle[:] = b'\x00' * len(bundle)
            proc.close()
            self._refuse(swoop_spawn.REFUSAL_SPAWN_FAILED, str(e))
            return

        with self._lock:
            self._proc = proc
            self._state = STATE_RUNNING
            self._viewers = set()
            self._controllers = set()
            self._last_status = {}
            self._last_refusal = None
            self._end_logged = False
            self._reader = threading.Thread(
                target=self._reader_loop, args=(proc, sid),
                name='swoop-reader', daemon=True,
            )
            self._reader.start()

        self._log_event('swoop_session_start', 'info', f'sid={sid} pid={proc.pid}')
        self._schedule_token_refresh(sid, TOKEN_TTL_DEFAULT_S)

    # host token refresh

    def _schedule_token_refresh(self, sid, ttl_s, delay=None):
        """Arm the timer that re-mints the host token ahead of its expiry.

        ``ttl_s`` is how long the token now in the streamer's hands lives;
        ``delay`` overrides the lead for a retry without moving the expiry.
        """
        with self._lock:
            if self._token_timer is not None:
                self._token_timer.cancel()
            self._token_expires_at = time.monotonic() + ttl_s
            wait = max(1.0, ttl_s - TOKEN_REFRESH_LEAD_S) if delay is None else delay
            self._token_timer = threading.Timer(wait, self._submit, args=(('token', sid),))
            self._token_timer.daemon = True
            self._token_timer.start()

    def _cancel_token_refresh(self):
        with self._lock:
            if self._token_timer is not None:
                self._token_timer.cancel()
                self._token_timer = None

    def _on_token_needed(self, sid):
        """The streamer lost its signaling socket under a live session and
        wants a fresh token to redial with — the same mint a scheduled
        refresh does, brought forward. Floored so a streamer asking on every
        tick cannot drive the bundle route."""
        with self._lock:
            live = self._proc is not None and self._sid == sid
            since = time.monotonic() - self._token_minted_at
        if not live or since < TOKEN_ASK_MIN_INTERVAL_S:
            return
        logger.warning('swoop: streamer asked for a fresh token (sid=%s); minting now', sid)
        self._submit(('token', sid))

    def _do_token(self, sid):
        with self._lock:
            proc = self._proc
            live = proc is not None and self._sid == sid
            expires_at = self._token_expires_at
        if not live:
            return
        try:
            bundle = self._spawn.fetch_bundle(
                sid, self._site_id(), self._machine_id(), self._auth_manager(),
            )
            try:
                fresh = json.loads(bytes(bundle))
            finally:
                bundle[:] = b'\x00' * len(bundle)
            token = fresh.get('hostToken') if isinstance(fresh, dict) else None
            if not isinstance(token, str) or not token:
                raise ValueError('bundle carried no hostToken')
            proc.write_line({'type': 'token', 'host_token': token})
            with self._lock:
                self._token_minted_at = time.monotonic()
        except Exception as e:
            remaining = expires_at - time.monotonic()
            if remaining > TOKEN_REFRESH_RETRY_S:
                logger.warning('swoop: host token refresh failed (%s); retrying in %ss',
                               type(e).__name__, TOKEN_REFRESH_RETRY_S)
                self._schedule_token_refresh(sid, remaining, delay=TOKEN_REFRESH_RETRY_S)
            else:
                self._log_event('swoop_token_refresh_failed', 'warning',
                                f'sid={sid} error={type(e).__name__}')
            return
        finally:
            token = None
            fresh = None
        self._log_event('swoop_token_refreshed', 'info', f'sid={sid}')
        self._schedule_token_refresh(sid, TOKEN_TTL_DEFAULT_S)

    def _spawn_gate(self):
        """Backoff and rate ceiling. Returns a refusal reason, or None."""
        now = time.monotonic()
        with self._lock:
            if now < self._retry_after:
                return 'backoff'
            self._spawn_times = [t for t in self._spawn_times if now - t < SPAWN_WINDOW_S]
            if len(self._spawn_times) >= SPAWN_CEILING:
                return 'spawn_rate_ceiling'
        return None

    def _refuse(self, reason, detail=None):
        with self._lock:
            self._last_refusal = reason
            if self._proc is None:
                self._state = STATE_IDLE
                self._sid = None
        logger.warning('swoop: refusing to spawn (%s)%s', reason,
                       f': {detail}' if detail else '')
        self._log_event('swoop_spawn_refused', 'warning',
                        f'reason={reason}' + (f' detail={detail}' if detail else ''))

    # teardown

    def _do_kill(self, reason):
        with self._lock:
            proc = self._proc
            sid = self._sid
            if proc is None:
                self._state = STATE_IDLE
                return
            self._state = STATE_STOPPING

        try:
            proc.write_line({'type': 'kill'})
        except Exception as e:
            logger.debug('swoop: kill line not delivered: %s', e)

        code = None
        try:
            code = proc.wait(KILL_GRACE_S)
        except Exception as e:
            logger.debug('swoop: wait failed: %s', e)
        # closing the job is what guarantees the exit: the streamer is boxed in a
        # job with KILL_ON_JOB_CLOSE, so this covers a streamer that ignored the line.
        proc.close()

        self._finish_session(proc, sid, reason, code)

    def _finish_session(self, proc, sid, reason, code):
        self._cancel_token_refresh()
        with self._lock:
            if self._proc is proc:
                self._proc = None
                self._state = STATE_IDLE
                self._viewers = set()
                self._controllers = set()
            already_logged = self._end_logged
            self._end_logged = True
            self._last_exit = {'reason': reason, 'code': code}
            self._apply_backoff(code)
        if not already_logged:
            self._log_event('swoop_session_end', 'info',
                            f'sid={sid} reason={reason} exit={code}')

    def _apply_backoff(self, code):
        """Called under the lock. A clean exit clears the ladder; a crash climbs it."""
        if code == swoop_spawn.EXIT_OK:
            self._backoff_s = 0
            self._retry_after = 0.0
            if self._spawn_times:
                self._spawn_times.pop()
            return
        self._backoff_s = (
            BACKOFF_BASE_S if not self._backoff_s
            else min(self._backoff_s * 2, BACKOFF_MAX_S)
        )
        self._retry_after = time.monotonic() + self._backoff_s

    # stdout reader

    def _reader_loop(self, proc, sid):
        try:
            for line in proc.iter_lines():
                self._handle_line(line)
        except Exception as e:
            logger.debug('swoop: stdout reader stopped: %s', e)

        # eof means the streamer is gone; find out how and let the ladder move.
        code = None
        try:
            code = proc.wait(KILL_GRACE_S)
        except Exception:
            pass
        with self._lock:
            unexpected = self._proc is proc
        if unexpected:
            reason = swoop_spawn.EXIT_REASONS.get(code, 'unknown')
            proc.close()
            self._finish_session(proc, sid, reason, code)

    def _handle_line(self, line):
        try:
            event = json.loads(line)
        except ValueError:
            logger.warning('swoop: unparseable stdout line dropped')
            return
        if not isinstance(event, dict):
            logger.warning('swoop: non-object stdout line dropped')
            return

        event_type = event.get('type')
        if event_type not in KNOWN_EVENTS:
            logger.warning('swoop: unknown stdout event %r dropped', event_type)
            return

        if event_type == EVENT_HOST_EVENT:
            self._queue_host_event(event)
        elif event_type == EVENT_TOKEN_NEEDED:
            self._on_token_needed(event.get('sid'))

        with self._lock:
            if event_type == EVENT_READY:
                self._state = STATE_RUNNING
            elif event_type == EVENT_VIEWER_JOINED:
                viewer = event.get('viewer')
                self._viewers.add(viewer)
                if event.get('ctl'):
                    self._controllers.add(viewer)
            elif event_type == EVENT_VIEWER_LEFT:
                viewer = event.get('viewer')
                self._viewers.discard(viewer)
                self._controllers.discard(viewer)
            elif event_type == EVENT_STATUS:
                self._last_status = {
                    k: v for k, v in event.items() if k not in ('type', 'sid')
                }

        try:
            self._events.put_nowait(event)
        except queue.Full:
            try:
                self._events.get_nowait()  # drop the oldest, keep the newest
                self._events.put_nowait(event)
            except queue.Empty:
                pass

    # host events -> the audit route

    def _queue_host_event(self, event):
        """Turn one ``host_event`` line into the audit route's row shape.

        The streamer's ``kind`` is that route's closed ``type`` vocabulary
        (PROTOCOL.md section 6), so it is copied across rather than mapped. A row
        missing either required field is dropped here: the route refuses the
        whole batch on one bad entry, and the rest of the batch is evidence.
        """
        kind = event.get('kind')
        sid = event.get('sid')
        if not isinstance(kind, str) or not isinstance(sid, str):
            logger.warning('swoop: host_event without a kind or a sid dropped')
            return

        row = {'type': kind, 'sid': sid}
        viewer = event.get('viewer')
        if isinstance(viewer, str):
            row['viewerId'] = viewer
        reason = event.get('reason')
        if isinstance(reason, str):
            row['reason'] = reason

        self._start_auditor()
        try:
            self._audit.put_nowait(row)
        except queue.Full:
            try:
                self._audit.get_nowait()  # drop the oldest, keep the newest
                self._audit.put_nowait(row)
            except queue.Empty:
                pass

    def _start_auditor(self):
        with self._lock:
            if self._auditor is not None and self._auditor.is_alive():
                return
            self._auditor = threading.Thread(
                target=self._audit_loop, name='swoop-audit', daemon=True,
            )
            self._auditor.start()

    def _audit_loop(self):
        while True:
            batch = [self._audit.get()]
            while len(batch) < AUDIT_BATCH_MAX:
                try:
                    batch.append(self._audit.get_nowait())
                except queue.Empty:
                    break
            try:
                self._spawn.post_host_events(
                    batch, self._site_id(), self._machine_id(), self._auth_manager(),
                )
            except Exception as e:
                # not retried: an audit row is evidence, not a command, and a
                # retry loop against a down api is how this thread stops
                # draining. requests' message carries the status and url only.
                logger.warning('swoop: %d host events not recorded: %s', len(batch), e)

    # side effects

    def _do_side_effects(self, enabled):
        if enabled:
            self._enable_side_effects()
        else:
            self._disable_side_effects()

    def _enable_side_effects(self):
        """Add the firewall rule and set the SAS policy, once, and never raise.

        Always on a worker thread -- a powershell spawn on the service's
        5-second loop would stall every other check. Nothing here elevates: the
        service is already SYSTEM, so there is no ``runas`` and no path that can
        raise a UAC prompt.
        """
        try:
            state = _read_side_effect_state()
            if state is None:
                # an unreadable record is not an empty one: capturing again
                # would record the 3 we set ourselves as the value to restore.
                logger.warning('swoop: side-effect record unreadable, nothing applied')
                return

            applied = []
            exe_path = shared_utils.get_swoop_exe_path()
            if not exe_path:
                logger.debug('swoop: streamer not installed, no firewall rule')
            # the recorded path, not a flag: an install that moved leaves a rule
            # scoped to the old exe, and only the path says so.
            elif state.get(STATE_KEY_FIREWALL) != exe_path:
                if _run_powershell(_firewall_create_script(exe_path)):
                    state[STATE_KEY_FIREWALL] = exe_path
                    applied.append('firewall')

            prior = None
            if STATE_KEY_SAS_PRIOR not in state:
                prior = _read_sas_value()
                if prior is None:
                    logger.warning('swoop: sas policy unreadable, leaving it alone')
                else:
                    state[STATE_KEY_SAS_PRIOR] = prior

            if not applied and prior is None:
                return

            if not _write_side_effect_state(state):
                # the record is the only thing that can undo the policy, so the
                # policy does not move until the record is on disk.
                return
            if prior is not None and _write_sas_value(SAS_ENABLED_VALUE):
                applied.append(f'sas prior={prior}')

            if applied:
                self._log_event('swoop_side_effects_applied', 'info', ' '.join(applied))
        except Exception as e:
            logger.error('swoop: applying side effects failed: %s', e)
            self._log_event('swoop_side_effects_failed', 'warning', f'enable: {e}')

    def _disable_side_effects(self):
        """Remove the rule and put the policy back exactly. Never raises."""
        try:
            state = _read_side_effect_state()
            if not state:
                # no record -- unreadable included -- means nothing of ours is
                # on this machine to undo.
                return

            removed = []
            if state.get(STATE_KEY_FIREWALL) and _run_powershell(_firewall_remove_script()):
                state.pop(STATE_KEY_FIREWALL)
                removed.append('firewall')
            if STATE_KEY_SAS_PRIOR in state:
                prior = state[STATE_KEY_SAS_PRIOR]
                if _restore_sas_value(prior):
                    state.pop(STATE_KEY_SAS_PRIOR)
                    removed.append(f'sas prior={prior}')

            # whatever is left failed and is retried on the next disable.
            if state:
                _write_side_effect_state(state)
            else:
                _clear_side_effect_state()

            if removed:
                self._log_event('swoop_side_effects_removed', 'info', ' '.join(removed))
        except Exception as e:
            logger.error('swoop: removing side effects failed: %s', e)
            self._log_event('swoop_side_effects_failed', 'warning', f'disable: {e}')

    # firebase plumbing

    def _auth_manager(self):
        return getattr(self._firebase, 'auth_manager', None)

    def _site_id(self):
        return getattr(self._firebase, 'site_id', None)

    def _machine_id(self):
        return getattr(self._firebase, 'machine_id', None)

    def _log_event(self, action, level, details):
        if self._firebase is None:
            return
        try:
            self._firebase.log_event(action, level, details=details)
        except Exception as e:
            logger.debug('swoop: log_event(%s) failed: %s', action, e)


# side-effect primitives. every one of them returns a value rather than raising,
# because the two callers above must never fail a session over a firewall rule.

def _read_side_effect_state():
    """The record as a dict, ``{}`` when there is none, ``None`` when unreadable."""
    try:
        with open(SIDE_EFFECT_STATE_PATH, 'r') as f:
            state = json.load(f)
    except FileNotFoundError:
        return {}
    except (OSError, ValueError) as e:
        logger.warning('swoop: side-effect record not readable: %s', e)
        return None
    return state if isinstance(state, dict) else None


def _write_side_effect_state(state):
    try:
        os.makedirs(os.path.dirname(SIDE_EFFECT_STATE_PATH), exist_ok=True)
        tmp_path = SIDE_EFFECT_STATE_PATH + '.tmp'
        with open(tmp_path, 'w') as f:
            json.dump(state, f, indent=2)
        os.replace(tmp_path, SIDE_EFFECT_STATE_PATH)
        return True
    except OSError as e:
        logger.error('swoop: side-effect record not written: %s', e)
        return False


def _clear_side_effect_state():
    try:
        os.remove(SIDE_EFFECT_STATE_PATH)
    except FileNotFoundError:
        pass
    except OSError as e:
        logger.warning('swoop: side-effect record not removed: %s', e)


def _ps_quote(text):
    """``text`` as a powershell single-quoted literal."""
    return "'" + str(text).replace("'", "''") + "'"


def _firewall_create_script(exe_path):
    """Remove-then-create, so a rule left by a relocated install is corrected
    rather than kept, and a second enable lands on the same two rules.

    ``-Profile Any`` because kiosks land on networks Windows calls Public, and
    a Private-only rule would fail exactly where swoop is needed.
    """
    common = (f"-Group {_ps_quote(FIREWALL_GROUP)} -Direction Inbound -Action Allow"
              " -Enabled True -Profile Any -Protocol UDP -ErrorAction Stop")
    return (
        f"Remove-NetFirewallRule -Name {_ps_quote(FIREWALL_RULE_NAME)}"
        " -ErrorAction SilentlyContinue;"
        f"New-NetFirewallRule -Name {_ps_quote(FIREWALL_RULE_NAME)}"
        f" -DisplayName {_ps_quote(FIREWALL_RULE_DISPLAY)} {common}"
        f" -LocalPort Any -Program {_ps_quote(exe_path)} | Out-Null;"
        f"Remove-NetFirewallRule -Name {_ps_quote(FIREWALL_MDNS_RULE_NAME)}"
        " -ErrorAction SilentlyContinue;"
        f"New-NetFirewallRule -Name {_ps_quote(FIREWALL_MDNS_RULE_NAME)}"
        f" -DisplayName {_ps_quote(FIREWALL_MDNS_RULE_DISPLAY)} {common}"
        f" -LocalPort {MDNS_PORT} | Out-Null"
    )


def _firewall_remove_script():
    """By group, so both rules go in one call and a missing one is not an error."""
    return (f"Remove-NetFirewallRule -Group {_ps_quote(FIREWALL_GROUP)}"
            " -ErrorAction SilentlyContinue; exit 0")


def _run_powershell(script, timeout=POWERSHELL_TIMEOUT_S):
    """Run one ``-Command`` and report whether it exited 0.

    No shell, no ``runas``, no ShellExecute: the service is already SYSTEM and
    nothing here may raise a UAC prompt.
    """
    try:
        result = subprocess.run(
            ['powershell', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', script],
            capture_output=True, text=True, timeout=timeout,
            creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0),
        )
    except Exception as e:
        logger.warning('swoop: powershell did not run: %s', e)
        return False
    if result.returncode != 0:
        logger.warning('swoop: powershell exited %s', result.returncode)
        return False
    return True


def _open_sas_key(access):
    import winreg
    # the 64-bit view explicitly: the policy lives there, and a 32-bit python
    # would otherwise be redirected into WOW6432Node.
    return winreg.OpenKey(winreg.HKEY_LOCAL_MACHINE, SAS_POLICY_KEY, 0,
                          access | winreg.KEY_WOW64_64KEY)


def _read_sas_value():
    """The policy value, :data:`SAS_ABSENT` when unset, ``None`` when unreadable."""
    try:
        import winreg
    except ImportError:
        return None
    try:
        with _open_sas_key(winreg.KEY_READ) as key:
            value, _ = winreg.QueryValueEx(key, SAS_VALUE_NAME)
        return int(value)
    except FileNotFoundError:
        return SAS_ABSENT
    except (OSError, TypeError, ValueError) as e:
        logger.warning('swoop: sas policy not readable: %s', e)
        return None


def _write_sas_value(value):
    try:
        import winreg
    except ImportError:
        return False
    try:
        with winreg.CreateKeyEx(winreg.HKEY_LOCAL_MACHINE, SAS_POLICY_KEY, 0,
                                winreg.KEY_SET_VALUE | winreg.KEY_WOW64_64KEY) as key:
            winreg.SetValueEx(key, SAS_VALUE_NAME, 0, winreg.REG_DWORD, int(value))
        return True
    except OSError as e:
        logger.warning('swoop: sas policy not written: %s', e)
        return False


def _delete_sas_value():
    try:
        import winreg
    except ImportError:
        return False
    try:
        with _open_sas_key(winreg.KEY_SET_VALUE) as key:
            winreg.DeleteValue(key, SAS_VALUE_NAME)
        return True
    except FileNotFoundError:
        return True  # already gone, which is what the caller asked for
    except OSError as e:
        logger.warning('swoop: sas policy not cleared: %s', e)
        return False


def _restore_sas_value(prior):
    """Put the policy back exactly: absent deletes the value, 0..3 sets it.

    Anything else is refused rather than guessed -- a damaged record must not
    turn a policy nobody set into one that is explicitly set.
    """
    if prior == SAS_ABSENT:
        return _delete_sas_value()
    if isinstance(prior, int) and not isinstance(prior, bool) and 0 <= prior <= SAS_VALUE_MAX:
        return _write_sas_value(prior)
    logger.warning('swoop: sas record is not restorable, policy left as it is')
    return False
