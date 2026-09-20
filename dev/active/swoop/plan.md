# swoop — Plan
**Created**: 2026-09-17 | **Status**: Active

Re-planned from scratch on 2026-09-17: the original `dev/active/swoop/` was gitignored and was destroyed in the
2026-09-16 data-loss event. This directory is force-added to git so that cannot happen twice. The evidence base
(five research reports, a Chrome-receiver deep dive, the reviewed draft and three adversarial reviews) is in
[research/](research/). Read [context.md](context.md) before executing any task.

## Summary

swoop is a Parsec-class remote KVM for Owlette. A Rust streamer (`agent/swoop` → `owlette-swoop.exe`), spawned on
demand by the agent service as SYSTEM in the console session, captures the desktop (DXGI Desktop Duplication),
encodes on the GPU and streams peer-to-peer to a full-window page on the dashboard, with input, cursor, clipboard
and audio. Cloudflare provides the signaling room (Worker + Durable Object, with an agent-held "doorbell" socket)
and the TURN fallback. It replaces the dashboard's "live view" for every machine whose agent can swoop;
"screenshot" stays.

## Owner requirements and rulings (2026-09-17 — settled, do not relitigate)

- Performance is the whole game: 50–100 ms input-to-photon, on par with Parsec. H.265 preferred. Peer-to-peer
  first, Cloudflare TURN fallback, must work on any network.
- Several users in one machine at once, everyone shares control; view-only is a permission. One user may open
  several machines in separate browser windows.
- UI: machine context menu → "swoop into this machine" → full-window / fullscreen page. Clipboard both ways,
  keyboard mapping across macOS/Linux/Windows clients incl. Cmd conversion, system audio with mute,
  bandwidth/quality options, synced visible cursor.
- Every GPU (NVIDIA, Intel, AMD) plus a no-GPU / VM software floor. Displays: single up to 4K, multi-monitor,
  giant spanned canvases, headless (v1 detects it and recommends a dummy plug; a virtual display driver is a
  later phase).
- Login screen, lock screen and UAC prompts work in the first release.
- Session start-up: Cloudflare Worker + Durable Object relay plus an agent doorbell WebSocket. Approved new
  dependencies: agent pip package `websocket-client`; a wrangler project with its own dev packages.
- Security defaults: swoop is off until enabled per site; control sessions need step-up auth; site admins
  control, members watch only; audit trail; kill switch.
- Authenticode signing (Azure Trusted Signing) before swoop ships to customers; unsigned pilot only on the
  owner's machines.
- **Doorbell reconnection is self-supervised in its own module** — a documented exception to "never spawn
  reconnection logic outside `ConnectionManager`". Reason: ConnectionManager's watchdog treats any dead
  supervised thread as a Firestore failure (`connection_manager.py:765-786`, `report_error` `:436-472`), so a
  Cloudflare outage would cycle the Firestore connection on every machine. ConnectionManager owns the Firestore
  connection, not every socket.
- `agent/owlette_installer.iss` edits are approved for exactly three things: the `{app}\swoop` payload entry,
  adding the streamer to the existing name+path kill pass, and uninstall cleanup (firewall rule, SAS policy).
- An **install-directory hardening release ships first**, planned separately; its details are held privately
  until it ships (this repository is public). This plan only adds `{app}\swoop` to the protected set and gates
  GA on that release.
- The plan lives in `dev/active/swoop/`, force-added to git.

## Contracts recovered from the lost plan (keep stable — `dev/active/tri-platform-agent` references them)

- Crate `agent/swoop`, binary `owlette-swoop.exe`, no cargo workspace, own `.cargo/config.toml` with
  `+crt-static`, VERSIONINFO + icon via `build.rs`.
- Decision 3: the service spawns the streamer with the session bundle on stdin. Secrets never on a command line.
  (The file fallback is dropped — see D2.)
- Decision 12: no GPU requirement anywhere; hardware encoders where present, software floor on every OS.
- **Task 2.2** = heartbeat keys `osFamily` / `arch` + `capabilities.swoop`. **Task 2.5** =
  `.github/workflows/rust-build.yml`. **Task 0.11** = record the `live-view-webrtc` reversal. **Spike 0.2**
  measures the MSRV floor. **Wave 9** = `#[cfg]` seams for the macOS/Linux backends (tri-platform Wave 8).
- Session store records `endReason`. Directories `ipc/swoop/`, `logs/swoop/`.
- C3 normalisation: `osFamily = {'win32':'windows','darwin':'macos','linux':'linux'}[sys.platform]`,
  `arch = {'AMD64':'x64','x86_64':'x64','arm64':'arm64','aarch64':'arm64'}[platform.machine()]`; absent means
  Windows; capability keys are written as separate dotted paths. `osadapter.streamer_capable()` does not exist
  on `dev` yet: swoop ships a local `streamer_capable()` (Windows: true) and tri-platform folds it in.

## Approach

```
browser (swoop page) --HTTPS--> owlette API: capability + site enablement + live step-up proof + audit,
        |                        mints viewer JWT + per-viewer key + ICE config, rings the doorbell (sid only)
        |                        and writes a sid-only fallback command (polled 2-5 s)
        | WSS (viewer JWT)
        v
  swoop-signal: Cloudflare Worker + one Durable Object per machine (WebSocket hibernation)
        ^                         ^
        | WSS (host JWT)          | WSS (doorbell JWT) - idle, hibernating, self-supervised
        |                         |
  owlette-swoop.exe  <-- spawn: SYSTEM token in the console session, anonymous pipes --  python agent service
        |                        (agent fetches the bundle from /api/agent/swoop/bundle; never from Firestore)
        v
browser <==== WebRTC P2P over DTLS ====> owlette-swoop.exe      (fallback: Cloudflare TURN, host-side allocation)
```

Host pipeline: Desktop Duplication (per output, desktop-switch aware) → GPU convert/scale only when needed →
encoder → framing/packetization → per-viewer sender (pacing + rate governor) → browser. Viewer feedback drives
bitrate / fps / resolution. Loss recovery in v1 is IDR with a 250–500 ms cooldown.

## Decisions

**D1 — Rust.** The hot path is GPU silicon; C++ buys nothing measurable. Memory safety matters for a SYSTEM
process that parses network input. The toolchain is already in the repo.

**D2 — Process model.** The service spawns `owlette-swoop.exe` on demand with its own SYSTEM token retargeted to
the active console session (the primitive exists: `_get_elevated_install_token`, `owlette_service.py:2777`),
`CreateProcessAsUser`, `WinSta0\Default`, Job Object `KILL_ON_JOB_CLOSE`. `_launch_command_as_user` passes
`bInheritHandles=0`, so swoop gets its own spawn helper with inheritable **anonymous pipes**: stdin carries the
bundle then control lines, stdout carries JSON-line events, stderr goes to `logs/swoop/`. No file seams between
the streamer and the service. One streamer per machine serves all viewers, lingers ~60 s after the last one
leaves, then exits. SYSTEM is required for secure-desktop capture/injection and GPU scheduling priority; no
elevation prompt is ever involved. Capture and input threads follow the input desktop
(`OpenInputDesktop`/`SetThreadDesktop`); duplication is re-created on `DXGI_ERROR_ACCESS_LOST`. Ctrl+Alt+Del:
the streamer emits a `sas_request` event, the service calls `SendSAS`. The agent refuses to spawn a streamer
whose `version` differs from its own (stale binary after a delayed-until-reboot upgrade).

**D3 — The video path is decision gate G1, measured in spike 0.2 — not a pick.** Candidates, one harness:
- **A** encoded frames over an RTCDataChannel (ordered + `maxPacketLifeTime`, ~1200-byte fragments) →
  WebCodecs → canvas. What Parsec web, moonlight-web, Selkies and RustDesk converged on; HEVC reaches Edge this
  way. Costs: app-level pacing/rate control; SCTP sender limits.
- **B** RTP media track → `<video>`, playout-delay extension `min=0`, `max ∈ (0, 500] ms` (**not** `max=0`,
  which makes Chrome fast-forward and PLI). Mature congestion control, NACK/RTX; no H.265 on Edge/Firefox.
- **C** the same RTP sender, but a receive-side `RTCRtpScriptTransform` hands frames to WebCodecs + canvas.
Rule: the winner beats B by ≥ 15 ms p50 photon latency on LAN and does not lose to B at 2% loss / 40 ms RTT;
ties go to the simpler path (B < C < A). Both ends hide the path behind one seam (`transport::VideoSink` on the
host, `web/lib/swoop/video/receiver.ts` in the browser) so the second path can be added later without touching
capture, encode, decode or presentation.

**D4 — Transport library: str0m first, LiveKit `libwebrtc` crate as the measured alternate.** str0m (HEAD
2026-09-15): RFC 7798 H.265 packetizer with Chrome interop on record, a port of libwebrtc GoogCC, pacer,
NACK/RTX, data channels, 12 fuzz targets, safe Rust. Known gaps: no TURN client, no mDNS, no FEC; its SCTP sender
caps buffering at 128 KiB across all channels with literal RFC 4960 congestion control (`RTO_MIN` 1000 ms) — path
A on str0m needs a patched `sctp-proto`, and 0.2 measures whether that is enough. If str0m fails G1, rerun on
the LiveKit crate; if a C++ stack wins, the process split (deferred track) becomes part of v1. Rejected with
reasons in `research/05-transport-bakeoff.md`: libdatachannel, GStreamer, Pion, webrtc-rs.

**D5 — Codecs.** HEVC Main 8-bit 4:2:0 where both ends can, H.264 as an equal first-class path, AV1 later.
Chosen per viewer from a client capability probe ∩ host encoder availability. Fixed landmines: NVENC H.264 must
set `bitstreamRestrictionFlag=1` + `max_num_reorder_frames=0` (Chrome's D3D11 decoder otherwise holds ~16 frames:
208 ms → 8 ms); VPS/SPS/PPS in-band with every IRAP; single-slice frames; a resolution change is always a new
IDR plus a decoder reconfigure; never submit a chunk with a dangling reference (Chrome hard-fails HEVC on a
missing prior slice); the host keeps a floor frame rate on a static desktop (hardware decoders on macOS stall
otherwise).

**D6 — Capture.** DXGI Desktop Duplication (dirty rects, cursor shape API, works as SYSTEM on the secure
desktop). Windows.Graphics.Capture only as a user-token helper if spike 5.7 shows Desktop Duplication failing.
swoop never changes display configuration without a per-machine opt-in: signage screens are public.

**D7 — Encoders behind one trait.** NVENC direct SDK first (ARGB in, on-chip conversion; P1 +
ultra-low-latency + CBR + 1-frame VBV + infinite GOP + no B-frames + no lookahead). Intel/AMD backend decided by
hardware spike 6.7 among FFmpeg `*_qsv`/`*_amf` (LGPL, dynamic link — what Sunshine ships), native oneVPL/AMF,
and Media Foundation as last resort, on named measurements. Software H.264 floor: openh264 or the in-box MF
software encoder — never x264 (GPL). Reference-frame invalidation / LTR is a deferred NVENC-only experiment.

**D8 — Signaling and tokens.** Browser always offers, host always answers, re-negotiation is "browser
re-offers", one PeerConnection per viewer. EdDSA JWTs with `kid`, minted only by the API; verified by the
Worker **and** independently by the streamer (public key arrives in the bundle; `exp` is checked against a
bundle-delivered time anchor, not the kiosk clock). Viewer claims: uid, site, machine, sid, viewer id, `ctl`,
`fp` (the browser's DTLS certificate fingerprint — mandatory), exp ≤ 60 s, single-use jti. Host authenticity:
per-viewer key `k = HKDF(K_session, viewerId)` with `K_session = HKDF(SWOOP_SESSION_MASTER_KEY, sid)` — derived,
never stored; the host MACs its DTLS fingerprint + sid with `k` so the relay cannot MITM (chosen over "host
reports its fingerprint through the API" only because it saves a round trip at connect). The streamer holds no
long-lived credential.

**D9 — The Firestore command channel carries an opaque `sid` and nothing else.** Site members can read
`commands/{doc}` (`firestore.rules:303-306`). swoop command types (`swoop_session_requested`, `swoop_kill`,
`swoop_refresh`) are written only by a dedicated action module, are **absent** from `ALLOWED_COMMAND_TYPES`, and
are in `_FAST_COMMAND_TYPES`. The bundle is fetched by the agent from `/api/agent/swoop/bundle`, which uses
`requireMachineAuthAndScope` (the `…OrSite…` helpers do not check `machine_id`).

**D10 — Authorization.** New capabilities `MACHINE_REMOTE_CONTROL` (site admin/owner) and
`MACHINE_REMOTE_VIEW` (members, when the site's `membersMayWatch` is on — default on, owner's ruling); both are
exempt from the `capability_enforcement=false` bypass. API-key callers are rejected outright
(`ctx.auth.keyContext !== null` → 403): step-up cannot apply to them. Step-up is a **live proof in the request**
(`verifyMfaProof` / `verifyPasskeyStepUpAssertion`, the `api/mfa/backup-codes` pattern), never a freshness
timestamp — the 30-day device-trust cookie births sessions with `mfaCompletedAt = now`. A successful ceremony
opens a 10-minute server-side step-up window stored against the **(user, machine)** pair, so a page reload —
which ends the swoop session and starts a new one — does not cost another ceremony. Reuse is gated on the
login session having passed a live ceremony ITSELF (`session.mfaSatisfiedBy`, set by the login challenge, by a
passkey-uv login, or by this very step-up): a device-trust-born session inherits no window however live it is,
which is what keeps the cookie named above out. Accounts with zero factors cannot control.
Live sessions hold a 5-minute lease the browser renews silently (the API re-checks membership, enablement and
capability); absolute cap 12 h. The host enforces `ctl` from the verified JWT. Site enablement lives at
`sites/{siteId}/settings/swoop` (covered by the existing `settings/{settingId}` rule).

**D11 — Kill switch.** The authoritative path is the streamer's own signaling socket (Worker broadcasts `kill`
→ streamer exits): ≤ 2 s. The doorbell covers an idle machine; the polled command is the last resort (2–5 s
pickup because swoop types are fast commands).

**D12 — No `firestore.rules` change.** `swoop_sessions` is read and written only by the API through the admin
SDK; the catch-all at `firestore.rules:940` already denies clients and no recursive wildcard reaches it. A rules
test pins that. Session docs hold no secrets.

**D13 — NAT.** P2P first (`stun.cloudflare.com`). Cloudflare Realtime TURN with **host-side allocation
preferred**: Cloudflare bills only server→client egress, so the video direction is unbilled when the host holds
the allocation (validated by metered spike 6.8; `customIdentifier` = site id). Until the host TURN client lands,
browser-side allocation is the fallback. Relayed sessions cap at 25–30 Mbps; TURN over TLS 443 runs a degraded
mode; fragment size respects the relay's path MTU. Relay→direct promotion by ICE restart. The service adds an
inbound-UDP firewall allow rule for the exe when swoop is enabled and removes it on disable/uninstall.

**D14 — Multi-viewer.** One capture; encoder tiers = min(codec classes present, measured encoder budget);
encoded frames fanned out; one shared host-uplink budget allocates per-viewer rates (controllers before
watchers); join and PLI keyframes are coalesced. Never "one client downgrades everyone".

**D15 — Fleet safety.** No machine loses both live view and swoop at any point: the dashboard shows "swoop"
when `capabilities.swoop == 1` and the legacy "live view" otherwise; legacy removal (Task 11.1) waits until the
fleet floor is the swoop agent version. `/api/agent/screenshot` stays (crash screenshots and cortex use it).
The installer kills a running streamer by name+path before replacing it. Rust `[profile.release]` is copied
verbatim from `agent/host` (the Bearfoos quarantine), and the build runs the Defender scan on the new exe.

**D16 — Instrumentation first.** The latency harness and its written measurement contract exist before pipeline
code. Every frame carries capture/encode/send timestamps; the client reports arrival/decode/present and an
app-level RTT, so the stats overlay shows a per-stage breakdown.

**D17 — Presentation contract (browser).** Present from the decoder output callback, never from
`requestAnimationFrame`; `desynchronized` canvas with an ImageBitmap fallback; `requestVideoFrameCallback` only
to measure; decode off the main thread where the platform allows.

## Names registry (every task uses these spellings)

| kind | name |
|---|---|
| binary / crate / install path | `owlette-swoop.exe` · `agent/swoop` · `{app}\swoop\owlette-swoop.exe` |
| streamer verbs | `run` (bundle on stdin) · `probe` (JSON capabilities) · `version` |
| pipe protocol | stdin: bundle line, then `{"type":"kill"}` / `{"type":"sas_result",…}`; stdout events: `ready`, `viewer_joined`, `viewer_left`, `sas_request`, `status`, `exiting` |
| exit codes | 0 normal · 10 bundle invalid · 11 version mismatch · 12 no capture source · 13 no encoder · 14 signaling unreachable · 20 internal |
| agent modules | `swoop_manager.py`, `swoop_spawn.py`, `swoop_doorbell.py`, `swoop_commands.py`, `swoop_capability.py` |
| command types (internal, sid only) | `swoop_session_requested`, `swoop_kill`, `swoop_refresh` |
| heartbeat keys | `capabilities.swoop`, `osFamily`, `arch` |
| Firestore | `sites/{s}/settings/swoop` = `{enabled, excludedMachineIds[], membersMayWatch, indicator}` · `sites/{s}/machines/{m}/swoop_sessions/{sid}` (server-only; `state`, `endReason`, viewers, timestamps) |
| capabilities | `MACHINE_REMOTE_CONTROL`, `MACHINE_REMOTE_VIEW` |
| user API | `POST …/machines/{m}/swoop/sessions` · `GET/DELETE …/swoop/sessions/{sid}` · `POST …/swoop/sessions/{sid}/lease` · `POST …/machines/{m}/swoop/kill` · `GET/PATCH /api/sites/{s}/swoop-settings` |
| agent API | `POST /api/agent/swoop/doorbell-token` · `POST /api/agent/swoop/bundle` · `POST /api/agent/swoop/events` |
| signaling Worker | `infra/swoop-signal/` · `GET /health` · `GET /v1/room/{siteId}/{machineId}` (WS) · `POST /v1/ring` · `POST /v1/kill` |
| signaling messages | `hello`, `ring`, `viewer-join`, `host-ready`, `offer`, `answer`, `candidate`, `kill`, `bye`, `error` |
| JWT | EdDSA, `kid`, `iss=owlette-api`, `aud ∈ {swoop-signal, swoop-host}`, `role ∈ {viewer, host, doorbell}` |
| env vars | `SWOOP_JWT_PRIVATE_KEY` (must-match), `SWOOP_JWT_PUBLIC_KEY`, `SWOOP_JWT_KID`, `SWOOP_SESSION_MASTER_KEY` (must-match), `SWOOP_SIGNAL_URL`, `SWOOP_SIGNAL_RING_SECRET` (must-match — a ring from the failover origin would otherwise 401 silently), `CLOUDFLARE_TURN_KEY_ID`, `CLOUDFLARE_TURN_KEY_API_TOKEN`; metering (Task 8.4) adds `CLOUDFLARE_ACCOUNT_ID` and `CLOUDFLARE_ANALYTICS_API_TOKEN` — the TURN bearer cannot query the GraphQL analytics API |
| web | page `/swoop/[siteId]/[machineId]` · libs `web/lib/swoop/` · hook `web/hooks/useSwoopSession.ts` · components `web/components/swoop/` |

## Waves

Conventions: (1) scaffolding tasks create every module directory, stub file, dependency entry and UI slot up
front, so parallel tasks only fill their own files — `agent/swoop/Cargo.toml` and `Cargo.lock` are edited only
by Task 1.2 (every crate pre-declared and pinned, heavy later-wave crates as optional dependencies behind cargo
features, `[features] default = ["encode-nvenc"]` so Waves 3–9 have a picture, and a non-default `testhooks`
feature gating the bundle `overrides` test hook) and Task 10.1 (finalises default features, never adding
`testhooks`); host features plug into `session/features.rs` through the
`session::Feature` trait and browser features into `web/lib/swoop/features.ts` through `attach(session)`, so
Wave 6+ never edits the session loop, the page or the hook; a task that finds a missing crate or hook stops and
logs it; (2) every Rust task's done-when includes
`cargo clippy -- -D warnings` and `cargo test`, run with the working directory set to `agent/swoop` (never
`--manifest-path`, which drops `.cargo/config.toml` and `+crt-static`); (3) labels: **[agent]** runs on this dev
box (RTX 2080 Ti, 2 monitors), **[human]** needs the owner's hardware, accounts or eyes.

- **Wave 0 — spikes and design memos** (code in `agent/swoop/spikes/`, memos in `dev/active/swoop/spikes/`):
  0.1 latency harness + measurement contract · 0.2 video-path + transport bake-off (**G1**) · 0.3 SYSTEM spawn
  with pipes + secure desktop · 0.4 signaling Worker + doorbell prototype · 0.5 threat model · 0.6 doorbell
  supervision design · 0.7 install-dir + uninstall-cleanup inventory · 0.8 capture probe · 0.9 NVENC
  configuration validation · 0.10 web presentation probe · 0.11 record the live-view-webrtc reversal
- **Wave 1 — contracts and scaffolds**: 1.1 `PROTOCOL.md` + golden vectors · 1.2 Rust crate scaffold + core
  types · 1.3 web foundations (capabilities, rate limits, bypass exemption, min version) · 1.4 env manifest +
  CSP + protected path · 1.5 agent paths and directories
- **Wave 2 — agent integration, server libraries, CI**: 2.1 spawn helper + SwoopManager · 2.2 capability
  heartbeat + fast command types · 2.3 doorbell client · 2.4 web server libraries · 2.5 `rust-build.yml` ·
  2.6 build + installer · 2.7 agent command handlers · 2.8 signaling Worker · 2.9 web protocol library ·
  2.10 Rust protocol core · 2.11 sid-only command action module · 2.12 browser matrix spike
- **Wave 3 — picture-path modules and APIs**: 3.1 agent wiring · 3.2 user API routes · 3.3 agent API routes ·
  3.4 Worker deploy pipeline · 3.5 security-gate + dependabot lockfile registration · 3.6 capture · 3.7 NVENC ·
  3.8 transport wiring · 3.9 signaling client + admission · 3.10 web signaling + peer · 3.11 web receive +
  decode · 3.12 web presentation + client capability probe
- **Wave 4 — first picture (G2)**: 4.1 host thin session · 4.2 stage page + UI slots · 4.3 input injection ·
  4.4 cursor · 4.5 GPU convert/scale · 4.6 web input capture + keymap · 4.7 governor + feedback
- **Wave 5 — first interactive session → internal pilot (G3)**: 5.1 host session v2 · 5.2 swoop page v2 ·
  5.3 dashboard entry · 5.4 site enablement + kill switch · 5.5 step-up ceremony UI · 5.6 audit + logs
  registry · 5.7 capture edge-case spike
- **Wave 6 — first-release features**: 6.1 secure desktop + Ctrl+Alt+Del · 6.2 clipboard · 6.3 audio ·
  6.4 displays · 6.5 quality menu + governor v2 + resolution change · 6.6 lease renewal + revocation ·
  6.7 encoder breadth spike · 6.8 TURN spike
- **Wave 7 — every GPU, every network**: 7.1 Intel/AMD backend · 7.2 software floor · 7.3 encoder selection +
  `probe` · 7.4 host-side TURN · 7.5 ICE policy · 7.6 relay caps + degraded mode · 7.7 enable/disable side
  effects + uninstall cleanup · 7.8 signing dry run
- **Wave 8 — multi-user and product integration**: 8.1 multi-user · 8.2 encoder tiers + uplink budget ·
  8.3 tray indicator · 8.4 relayed-GB metering · 8.5 CLI + OpenAPI + docs · 8.6 signing in the release
  pipeline · 8.7 e2e + integration tests
- **Wave 9 — `#[cfg]` platform seams**: 9.1 (the number tri-platform's Wave 8 points at)
- **Wave 10 — release (G4)**: 10.1 release — alone in its wave, because it depends on everything before it and
  must build from a quiescent tree
- **Wave 11 — legacy live view removal**: 11.1, gated on the fleet floor being the swoop agent version.
  Deferred tracks, each its own `/plan` when its trigger fires: virtual display driver
  (IddCx, EV cert + attestation); process split (mandatory in v1 if a C++ transport wins G1); second video
  path; NVENC reference invalidation / LTR; Windows.Graphics.Capture helper; touch/mobile viewer; file
  transfer; SFU for N ≥ 4 viewers; UPnP opt-in.

Full task text: [tasks.md](tasks.md).

## Gates

- **G1** (after 0.2): video path and transport library chosen by measurement; memo signed off by the owner.
  Task 1.1 and every transport task are written against the winner.
- **G2** (after Wave 4): a frame from this dev box reaches a canvas through the real API and signaling service.
- **G3** (after Wave 5): a measured interactive LAN session meets the latency criteria → unsigned internal pilot
  on the owner's machines (NVIDIA, logged-in desktop).
- **G4** (Task 10.1): every success criterion below is met; builds are signed; the install-directory security
  release has shipped.

## Start now (long lead, owner only)

Azure Trusted Signing identity validation · Cloudflare: Workers + Durable Objects enabled, a Realtime TURN key,
an API token for deploys · test hardware: Intel iGPU box, AMD box, 4-core VM, a TouchDesigner machine in perform
mode, a Mac and a Linux client, a ≥ 120 Hz monitor · counsel's position on HEVC patent licensing.

## Risks

1. The congestion/pacing story on path A is ours to build, and str0m's SCTP sender is weak today.
2. str0m has thin production evidence and no TURN client (3–6 engineer-weeks plus an interop tail).
3. A GPU-saturated TouchDesigner box pushes encode latency from ~5 ms to 20–30 ms.
4. EDR false positives for a SYSTEM binary that captures and injects; a brand-new exe has no reputation.
5. Win11 24H2/25H2 Desktop Duplication regressions.
6. Browser hardware-decoder limits across several windows; HEVC has no software fallback; Edge HEVC may need
   the paid HEVC Video Extension.
7. Cloudflare's billing asymmetry and per-allocation shaping are documented but unmeasured by us.
8. Keyboard Lock is Chrome/Edge only: Safari and Firefox leak system shortcuts.
9. HEVC patent licensing position for a commercial product.
10. The install-directory security release is a prerequisite this plan does not control.

## Success criteria

- Latency (photon-inclusive, real LAN hop, Chrome fullscreen, 1080p60, NVENC): 60 Hz client p50 ≤ 55 ms and
  p95 ≤ 80 ms; ≥ 120 Hz client p50 ≤ 40 ms; WAN at RTT ≤ 40 ms p50 ≤ 100 ms. No visible judder on a static
  60 fps test pattern.
- Choose swoop → first frame: p50 ≤ 1.5 s with a warm doorbell, ≤ 3 s relayed over TLS, ≤ 8 s on the polled
  fallback.
- Connects on: same LAN, server-reflexive, TURN/UDP, TURN/TLS 443.
- Every GPU class and the software floor produce a stream; HEVC when both ends can, H.264 otherwise.
- Login screen after a reboot with nobody logged in, lock screen and a UAC prompt are visible and controllable;
  Ctrl+Alt+Del works.
- Three viewers with mixed codecs on one machine; view-only enforced by the host; nobody is downgraded by
  someone else's codec.
- Clipboard text + image both ways; audio with mute; cursor shape and position in sync; Cmd mapping.
- Off by default; live step-up enforced; API keys refused; audit rows for start, end, deny, kill and control
  grants; the kill switch ends a live session in ≤ 2 s; a removed member is dropped within one lease (≤ 5 min).
- A 10-minute signaling outage leaves the agent's Firestore connection CONNECTED. The 5-second loop is never
  blocked. No UAC prompt anywhere. Screenshot paths and `/api/agent/screenshot` are intact. Agent suite, web
  unit tests, rules tests, e2e and the security gate are green.
- Upgrading from the oldest fielded version leaves a working swoop and never strands a streamer; uninstall
  removes the firewall rule and the SAS policy; no machine ever has neither live view nor swoop.
- Customer builds are Authenticode-signed before the SLSA subjects are hashed.
