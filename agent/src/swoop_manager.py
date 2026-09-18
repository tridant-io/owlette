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
import queue
import threading
import time

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
KNOWN_EVENTS = frozenset({
    EVENT_READY, EVENT_VIEWER_JOINED, EVENT_VIEWER_LEFT,
    EVENT_SAS_REQUEST, EVENT_HOST_EVENT, EVENT_STATUS, EVENT_EXITING,
})

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
# under the backoff is still a loop, so cap the spawns in a rolling window.
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
