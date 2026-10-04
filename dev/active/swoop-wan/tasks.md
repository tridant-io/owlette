# swoop across the internet — Tasks
**Progress**: 4/9 complete

## Wave 1: STUN on both ends

- [x] **Task 1.1: The agent's bundle carries STUN** `[agent]`
  - Files: `web/lib/swoop/turn.server.ts`, `web/app/api/agent/swoop/bundle/route.ts`,
    `web/app/api/sites/[siteId]/machines/[machineId]/swoop/sessions/route.ts`, their tests.
  - Do: Export one `STUN_ONLY` from `turn.server.ts`; both routes fall back to it when the mint fails. Route tests
    assert `iceServers` in the session response and in the bundle, configured and not.
  - Done when: jest for both routes and `turn.server`, eslint and tsc clean.

- [x] **Task 1.2: The host gathers a server-reflexive candidate** `[agent]`
  - Files: `agent/swoop/src/transport/stun.rs` (new), `agent/swoop/src/transport/mod.rs`,
    `agent/swoop/src/transport/rtc.rs`, `agent/swoop/src/session/mod.rs`.
  - Do: Resolve the bundle's first `stun:` URL off the session thread; `PeerConfig` gains `stun_server`. After bind,
    send a Binding request from the peer's socket, retransmit on the poll (RFC 8489 schedule, capped), intercept the
    reply by source and transaction id before str0m, decode XOR-MAPPED-ADDRESS by hand, and add
    `Candidate::server_reflexive(mapped, local, "udp")` unless mapped equals local. Never block the session thread.
  - Done when: `cargo clippy -- -D warnings` and `cargo test` pass on Windows; unit tests cover the encode, the XOR
    decode (RFC 5769 vectors), a reply from the wrong source or transaction ignored, retransmit and give-up, and a
    loopback fake STUN server that yields a srflx candidate on a real peer.

- [x] **Task 1.3: Measured on real networks** `[agent]`
  - Do: A `probe` key or an ignored live test that binds like a peer and asks `stun.cloudflare.com`; run it on B4A and
    the Mac; the mapped IPv4 must equal the network's public address (compared with an HTTP echo service).
  - Done when: the readings are in `dev/active/swoop-wan/proof.md`.

## Wave 2: the viewer, and the TURN client

- [x] **Task 2.1: The viewer says when no path exists** `[agent]`
  - Files: `web/lib/swoop/peer.ts`, `web/hooks/useSwoopSession.ts`, `web/components/swoop/SwoopStage.tsx`, tests.
  - Do: No selected pair 20 s after the first answer (and across restarts) surfaces a `no_path` state; the stage says
    "can't reach this machine from your network", plus "no relay is set up for this site" when the session had no
    relay servers. Restarts keep running underneath.
  - Done when: jest covers the deadline and both copies; eslint and tsc clean.

- [ ] **Task 2.2: A sans-IO TURN client** `[agent]`
  - Files: `agent/swoop/src/transport/turn/mod.rs`, `alloc.rs`, `md5.rs`, `wire.rs`.
  - Do: Allocate (REQUESTED-TRANSPORT UDP) with the 401 realm/nonce retry and long-term credentials (key =
    MD5(username:realm:password), MESSAGE-INTEGRITY by HMAC-SHA1), Refresh at half the lifetime, CreatePermission for
    public peer IPs only (rate-limited), ChannelBind for the nominated peer, Send/Data indications and ChannelData
    framing, stale-nonce retry. Never log a credential or username.
  - Done when: clippy and tests pass; tests use RFC 1321 MD5 vectors and RFC 5769 integrity vectors, and drive every
    state with a scripted server.

## Wave 3: the relay in the session

- [ ] **Task 3.1: Relayed candidates carry media** `[agent]`
  - Files: `agent/swoop/src/transport/rtc.rs`, `agent/swoop/src/session/mod.rs`.
  - Do: With a `turn:` server and credentials in the bundle, allocate on the peer's socket, add
    `Candidate::relayed(relay, local, "udp")`, demultiplex TURN traffic before str0m and feed relayed datagrams as
    `Receive{source: peer, destination: relay}`, wrap Transmits whose source is the relay, permission each remote
    public candidate, bind a channel when the relay pair is nominated, call `governor.set_path_profile`, report
    `path` in status.
  - Done when: clippy and tests pass, including two real `Rtc` peers on loopback that connect only through a fake
    TURN server.

- [ ] **Task 3.2: Measured through a real TURN server** `[agent]`
  - Do: coturn on the kiosk VM (lab only, long-term credentials); an ignored live test from B4A allocates, permits,
    binds and echoes through it. Repeat against Cloudflare when the owner's key exists.
  - Done when: the readings are in `proof.md`.

## Wave 4: ship it

- [ ] **Task 4.1: Docs and release** `[agent]`
  - Do: `swoop.mdx` says what networks work and what a relay adds; both changelogs; release with the next version.
  - Done when: released to dev and installed on the four machines.

- [ ] **Task 4.2: The owner's half** `[human]`
  - Do: Create a Cloudflare Realtime TURN key; set `CLOUDFLARE_TURN_KEY_ID` and `CLOUDFLARE_TURN_KEY_API_TOKEN` on
    railway-dev (`.claude/skills/env-management.md`); one swoop session from a phone on a cellular network, with and
    without the key.
  - Done when: both sessions are recorded in `proof.md`.

## Log
### 2026-10-04
- Plan written from two research passes (host transport; viewer, API and signaling), on the owner's instruction to lay
  the groundwork and execute it overnight.
- 1.1: the bundle route falls back to the shared STUN_ONLY; 119 jest tests across four suites, the new bundle test
  failed with `[]` restored; eslint and tsc clean.
- 1.2: transport/stun.rs, a sans-IO RFC 8489 binding from each peer's own socket, the reply taken off the socket before
  str0m, a srflx candidate trickled when the mapping differs; clippy clean (default and audio-opus), lib tests 408
  and 417 pass. 1.3: live from A4D, the srflx address equals the office's public IP (proof.md).
- 2.1: no media path 20 s after the first answer says "can't reach this machine from your network", with or without
  a relay; 888 jest tests in the swoop suites pass, eslint and tsc clean.
