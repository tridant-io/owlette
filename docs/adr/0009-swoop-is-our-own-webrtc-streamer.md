# swoop is our own streamer: Rust, WebRTC peer-to-peer, Cloudflare signalling

The owner's bar for remote control is 50–100 ms input-to-photon, on par with Parsec, on any network, and working on the login screen, lock screen and UAC prompts from the first release. So swoop is a Rust streamer (`owlette-swoop`) started on demand on the machine (on Windows by the service, as SYSTEM in the console session) that streams peer-to-peer over WebRTC to a dashboard tab, with a Cloudflare Worker and Durable Object as the signalling room and Cloudflare TURN as the relay when no direct path exists. Rust because the hot path is GPU silicon where C++ buys nothing measurable, and memory safety matters in a SYSTEM process that parses network input.

## Consequences

- The agent's doorbell socket reconnects itself, outside `ConnectionManager`. This is a documented exception to that guardrail: `ConnectionManager` treats any dead supervised thread as a Firestore failure, so one Cloudflare incident would cycle a healthy Firestore link on every machine (`agent/src/swoop_doorbell.py`).
- swoop is a human-in-the-loop surface: off until a site turns it on, control behind a step-up, and an API key can never start a session.
- It is the one exception to agents that only dial out (ADR 0003).
