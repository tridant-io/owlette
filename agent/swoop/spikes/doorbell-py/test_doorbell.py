"""Offline tests for the spike doorbell client.

Run: .venv/Scripts/python -m unittest -v   (working directory: this directory)
The wire is measured by ../signal-worker/scripts/measure.mjs; these cover the parts
that must hold without a Worker running.
"""

import json
import unittest

from doorbell import RoomClient, SpikeDoorbell

URL = "ws://127.0.0.1:8789/v1/room/spikesite/spikemachine"
TOKEN = "header.payload.signature"


class RoomClientTest(unittest.TestCase):
    def test_token_travels_in_a_header_and_never_in_the_url(self):
        client = RoomClient(URL, TOKEN, "doorbell", lambda *_: None)
        self.assertEqual(client._app.url, URL)
        self.assertNotIn(TOKEN, client._app.url)
        self.assertEqual(client._app.header, ["Authorization: Bearer " + TOKEN])

    def test_malformed_payload_reports_state_instead_of_raising(self):
        states = []
        client = RoomClient(URL, TOKEN, "host", lambda *_: None, lambda role, state, fields: states.append(state))
        client._handle_message(None, "{not json")
        self.assertEqual(states, ["malformed_message"])

    def test_handshake_error_reports_only_the_exception_class(self):
        states = []
        client = RoomClient(URL, TOKEN, "host", lambda *_: None, lambda role, state, fields: states.append(fields))
        client._handle_error(None, ValueError("Handshake status 403 for " + TOKEN))
        self.assertEqual(states, [{"error": "ValueError"}])


class SpikeDoorbellTest(unittest.TestCase):
    def setUp(self):
        self.rings = []
        self.doorbell = SpikeDoorbell(URL, TOKEN, lambda sid, latency_ms: self.rings.append((sid, latency_ms)))

    def deliver(self, message, received_at_ms):
        self.doorbell._client._on_message("doorbell", json.loads(json.dumps(message)), received_at_ms)

    def test_ring_calls_back_with_one_way_latency(self):
        self.deliver({"type": "ring", "sid": "abc", "sentAtMs": 1000.0}, 1042.5)
        self.assertEqual(self.rings, [("abc", 42.5)])

    def test_ring_without_a_stamp_still_calls_back(self):
        self.deliver({"type": "ring", "sid": "abc", "sentAtMs": None}, 1042.5)
        self.assertEqual(self.rings, [("abc", None)])

    def test_other_room_traffic_does_not_ring_the_agent(self):
        for message_type in ("hello", "viewer-join", "offer", "candidate", "kill", "error"):
            self.deliver({"type": message_type}, 1.0)
        self.assertEqual(self.rings, [])


if __name__ == "__main__":
    unittest.main()
