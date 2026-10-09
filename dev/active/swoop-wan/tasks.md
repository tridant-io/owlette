# swoop across the internet — Tasks
**Progress**: 6/9 complete

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

- [x] **Task 2.2: A sans-IO TURN client** `[agent]`
  - Files: `agent/swoop/src/transport/turn/mod.rs`, `alloc.rs`, `md5.rs`, `wire.rs`.
  - Do: Allocate (REQUESTED-TRANSPORT UDP) with the 401 realm/nonce retry and long-term credentials (key =
    MD5(username:realm:password), MESSAGE-INTEGRITY by HMAC-SHA1), Refresh at half the lifetime, CreatePermission for
    public peer IPs only (rate-limited), ChannelBind for the nominated peer, Send/Data indications and ChannelData
    framing, stale-nonce retry. Never log a credential or username.
  - Done when: clippy and tests pass; tests use RFC 1321 MD5 vectors and RFC 5769 integrity vectors, and drive every
    state with a scripted server.

## Wave 3: the relay in the session

- [x] **Task 3.1: Relayed candidates carry media** `[agent]`
  - Files: `agent/swoop/src/transport/rtc.rs`, `agent/swoop/src/session/mod.rs`.
  - Do: With a `turn:` server and credentials in the bundle, allocate on the peer's socket, add
    `Candidate::relayed(relay, local, "udp")`, demultiplex TURN traffic before str0m and feed relayed datagrams as
    `Receive{source: peer, destination: relay}`, wrap Transmits whose source is the relay, permission each remote
    public candidate, bind a channel when the relay pair is nominated, call `governor.set_path_profile`, report
    `path` in status.
  - Done when: clippy and tests pass, including two real `Rtc` peers on loopback that connect only through a fake
    TURN server.

- [ ] **Task 3.3: The host's relay over TCP and TLS** `[agent]`
  - Do: Issue #328's remaining ask. The host allocates over UDP 3478 only; a machine on a network that allows no UDP
    out gathers neither a server-reflexive nor a relay candidate. Cloudflare also lists `turn:…:53?transport=udp`,
    `turn:…:3478?transport=tcp` and `turns:…:5349|443`: try UDP 53 as a second UDP server first (cheap, same
    socket), then a TCP/TLS leg (a second transport under the peer: TURN over a stream per RFC 8656 §3.1 with
    RFC 4571 framing, reported as `PathProfile::RelayTls`). Also: re-allocate when an allocation is lost mid-session (the 12 h
    credential ttl ends a relayed session today, `turn.server.ts`), which needs re-minted credentials from the api.
  - Done when: a host on a UDP-blocked lab network connects through TLS 443; a relayed session outlives 12 h.

- [ ] **Task 3.2: Measured through a real TURN server** `[agent]`
  - Do: coturn on the kiosk VM (lab only, long-term credentials); an ignored live test from B4A allocates, permits,
    binds and echoes through it. Repeat against Cloudflare when the owner's key exists.
  - Done when: the readings are in `proof.md`.

## Wave 4: ship it

- [ ] **Task 4.1: Docs and release** `[agent]` (docs and changelog done 2026-10-09; release pending)
  - Order: the web with the viewer change (the browser's stage 2 no longer stands down for a host relay) must be
    live in an environment before its machines get 4.1.8; an old web with a new host leaves a UDP-blocked viewer
    without its browser relay. Dev deploys the web on merge; at the prod promotion, web first, then the installer.
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
- 1.1, 1.2 and 2.1 shipped in 4.1.3 (PR #282, tag v4.1.3).
- 2.2: transport/turn/{md5,wire,alloc}.rs behind the `turn` feature: RFC 1321 MD5, RFC 8489 framing with
  MESSAGE-INTEGRITY (HMAC-SHA1 from str0m's provider) and FINGERPRINT, ChannelData, and an Allocation state machine
  (401 and 438 retries, refresh, public-only permissions rate-limited, channels, Send/Data). RFC 5769 vectors 2.1 and
  2.4 reproduce byte for byte. `cargo test --features turn`: 432 lib tests pass. CI does not build the feature yet.
- 3.2 (partly): an opt-in live test allocated and released on a lab coturn (proof.md), proving the long-term
  credential path against a real server. Still open: relayed media through permissions and channels, and Cloudflare
  with the owner's key.
- 3.1 not started: host-side relay wiring into rtc.rs. With the owner's Cloudflare key set, the browser's stage-2
  relay already works against a host that now offers its public address, so 3.1 is the cheaper path (D13) and the
  fix for UDP-blocked host networks, not a prerequisite for relayed sessions.

### 2026-10-09
- Issue #328 (dbagaric): a session from a 5G hotspot to `mini` in Zagreb failed with "even the relay could not get
  through" with the Cloudflare key set on dev. The host logs showed what the plan predicted: host + srflx only,
  no relay. Something between the office and the relay dropped the viewer's relayed checks (an egress filter or a
  NAT mapping the relay could not hit; which one is unconfirmed, and the fix's path avoids all of them: the host
  only ever talks to the relay on 3478). The host's own `peer poll failed: poll_output` hid its cause behind
  anyhow's outer context; it now logs the chain.
- 3.1 done on branch `swoop/host-relay` (worktree `Owlette-swoop-wan-wt`): `Allocation` wired into `RtcPeer` on each
  viewer's socket (bind starts it; TURN datagrams taken off the socket by content, so one address serving STUN and
  TURN works; relayed receives fed to str0m at the relayed address; transmits whose source is the relayed address
  wrapped, with a permission asked for on the first miss; permissions for every remote candidate, trickled or in
  the offer; a channel bound once the relay pair is nominated; the allocation released on drop). The session
  resolves the bundle's `turn:` UDP entry off-thread like STUN, hands it to each peer, sets the governor's path
  profile from the ICE edges and reports `path: relay` in status. The `turn` cargo feature is gone: the client ships
  in every build.
- Tests: `turn/fake.rs`, a TURN server for tests (401 challenge, long-term integrity, permissions, channels, Send and
  Data, ChannelData), and in rtc.rs: the allocation becomes one trickled `typ relay` candidate and is released on
  drop; a silent relay leaves the peer without one; two peers connect only through the fake relay (the viewer's
  one candidate is an unroutable public address, the host's relay candidate its only route) with the pair reported
  relayed and a channel bound. 455 lib tests, clippy clean, default and audio-opus.
- Viewer: the browser's stage-2 relay no longer stands down when the host holds one (a pair on it is chosen only
  when nothing else works, and on a udp-blocked network nothing else can). `SwoopNoPath` says which ends reached
  the relay and the stage copy names the network to look at. Docs: the "from another network" section lists the
  machine's outbound needs. Changelog entry under Unreleased; ships with the next release.
- Still owed: 3.2 against Cloudflare (a real session from off-net; the reporter can rerun from the hotspot once
  the release is on `mini`), 3.3 (host TCP/TLS, re-allocation), 4.1's release, 4.2. Not proven: UDP 3478 out from
  the Zagreb office to `turn.cloudflare.com` (141.101.90.1), a different address from the STUN that worked
  (162.159.207.0).
