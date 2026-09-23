"""Spike 0.4 measurement driver for the python half.

Reads one JSON configuration line on stdin (so no token ever reaches a command
line) and writes JSON-line events on stdout. The node half in
``../signal-worker/scripts/measure.mjs`` drives it.

  in : {"url": "...", "doorbellToken": "...", "hostToken": "..."}
  out: {"event": "ready"|"ring"|"hop"|"rtt-echo"|"state"|"stopped", ...}
"""

import json
import sys

from doorbell import RoomClient, SpikeDoorbell, now_ms


def emit(event, **fields):
    sys.stdout.write(json.dumps(dict(event=event, **fields)) + "\n")
    sys.stdout.flush()


def on_state(role, state, fields):
    emit("state", role=role, state=state, **fields)


def main():
    config = json.loads(sys.stdin.readline())
    url = config["url"]

    doorbell = SpikeDoorbell(
        url,
        config["doorbellToken"],
        lambda sid, latency_ms: emit("ring", sid=sid, latencyMs=latency_ms),
        on_state,
    )

    host = None

    def handle_host_message(_role, message, received_at_ms):
        message_type = message.get("type")
        sent_at_ms = message.get("sentAtMs")
        if message_type == "candidate" and sent_at_ms is not None:
            emit("hop", messageType="candidate", seq=message.get("seq"), latencyMs=received_at_ms - sent_at_ms)
        elif message_type == "offer":
            # The round-trip arm: bounce straight back to the viewer that sent it.
            host.send({"type": "answer", "to": message.get("from"), "seq": message.get("seq")})
            emit("rtt-echo", seq=message.get("seq"), atMs=now_ms())

    if not doorbell.start():
        emit("state", role="doorbell", state="open_timeout")
        return 1

    roles = ["doorbell"]
    if config.get("hostToken"):
        host = RoomClient(url, config["hostToken"], "host", handle_host_message, on_state)
        if not host.start():
            emit("state", role="host", state="open_timeout")
            return 1
        roles.append("host")

    emit("ready", roles=roles)

    for line in sys.stdin:
        if line.strip() and json.loads(line).get("type") == "stop":
            break

    if host is not None:
        host.stop()
    doorbell.stop()
    emit("stopped")
    return 0


if __name__ == "__main__":
    sys.exit(main())
