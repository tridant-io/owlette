"""Spike 0.4 doorbell client: one WebSocket to the signaling room on a daemon thread.

Not the product module. Task 2.3 owns ``agent/src/swoop_doorbell.py``, and Task 0.6
owns the supervision state machine — this client deliberately has no reconnection,
no backoff and no circuit breaker, so the spike measures the wire and nothing else.

Nothing here logs, prints or stores token material.
"""

import json
import threading
import time

import websocket

PING_INTERVAL_S = 20
PING_TIMEOUT_S = 10


def now_ms():
    """Wall-clock milliseconds.

    On Windows this reads GetSystemTimePreciseAsFileTime, the same clock node's
    Date.now() reads, so a timestamp minted in the node half of the spike can be
    subtracted from one minted here.
    """
    return time.time() * 1000.0


class RoomClient:
    """Dials ``/v1/room/{site}/{machine}`` with a role token and dispatches messages.

    The agent is not a browser, so the token travels in an Authorization header and
    never in the URL — a URL would reach Cloudflare's access logs.
    """

    def __init__(self, url, token, role, on_message, on_state=None):
        self._role = role
        self._on_message = on_message
        self._on_state = on_state
        self._thread = None
        self._opened = threading.Event()
        self._app = websocket.WebSocketApp(
            url,
            header=["Authorization: Bearer " + token],
            on_open=self._handle_open,
            on_message=self._handle_message,
            on_close=self._handle_close,
            on_error=self._handle_error,
        )

    @property
    def role(self):
        return self._role

    def start(self, timeout_s=10):
        self._thread = threading.Thread(
            target=self._app.run_forever,
            kwargs={"ping_interval": PING_INTERVAL_S, "ping_timeout": PING_TIMEOUT_S},
            name="swoop-spike-" + self._role,
            daemon=True,
        )
        self._thread.start()
        return self._opened.wait(timeout_s)

    def send(self, message):
        self._app.send(json.dumps(message))

    def stop(self):
        self._app.close()
        if self._thread is not None:
            self._thread.join(timeout=5)

    def _emit_state(self, state, **fields):
        if self._on_state is not None:
            self._on_state(self._role, state, fields)

    def _handle_open(self, _app):
        self._opened.set()
        self._emit_state("open")

    def _handle_message(self, _app, raw):
        received_at_ms = now_ms()
        try:
            message = json.loads(raw)
        except ValueError:
            self._emit_state("malformed_message")
            return
        self._on_message(self._role, message, received_at_ms)

    def _handle_close(self, _app, status_code, reason):
        self._emit_state("close", code=status_code, reason=reason)

    def _handle_error(self, _app, error):
        # The class name alone: an error string from a handshake refusal can carry
        # the request line, and the request line can carry a subprotocol token.
        self._emit_state("error", error=type(error).__name__)


class SpikeDoorbell:
    """The doorbell role: idle until the Worker rings it, then calls back.

    ``on_ring(sid, latency_ms)`` runs on the client's own thread, never on a caller's.
    """

    def __init__(self, url, token, on_ring, on_state=None):
        self._on_ring = on_ring
        self._client = RoomClient(url, token, "doorbell", self._handle_message, on_state)

    def start(self, timeout_s=10):
        return self._client.start(timeout_s)

    def stop(self):
        self._client.stop()

    def _handle_message(self, _role, message, received_at_ms):
        if message.get("type") != "ring":
            return
        sent_at_ms = message.get("sentAtMs")
        latency_ms = None if sent_at_ms is None else received_at_ms - sent_at_ms
        self._on_ring(message.get("sid"), latency_ms)
