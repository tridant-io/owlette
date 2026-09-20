# swoop — DRAFT plan for adversarial review (2026-09-17)

Status: draft. Not yet shown to the owner. Reviewers: attack it.

## 1. What we are building

swoop is a Parsec-class remote KVM for Owlette (fleet manager for TouchDesigner installs, signage, kiosks, media servers). It replaces the dashboard's "live view" (a 5–60 s screenshot slideshow); "screenshot" stays.

Owner's hard requirements:
- Performance is the whole game: 50–100 ms input-to-photon, "on par with Parsec". JetKVM-class (~100 ms wired LAN) is the thing to beat.
- H.265 preferred. Peer-to-peer first, Cloudflare TURN fallback, must work on any network.
- Several users in one machine at once (everyone shares control; view-only is a permission). One user can open several machines in separate browser windows.
- Browser client on the Owlette dashboard: machine context menu → "swoop into this machine" → full-window / fullscreen stream page.
- Clipboard both ways, keyboard mapping across macOS/Linux/Windows clients incl. Cmd conversion, system audio with mute, bandwidth/quality options, synced visible cursor.
- Every GPU (NVIDIA, Intel, AMD) plus a no-GPU / VM software floor. Displays: single up to 4K, multi-monitor, giant spanned canvases (Mosaic), headless (v1: detect + recommend dummy plug; virtual display driver is a later phase).
- Windows login screen, lock screen and UAC prompts must work in the first release.
- Security defaults: off until enabled per site; step-up auth (passkey/MFA re-check) for control sessions; site admins control, members watch only; audit trail; kill switch.
- Authenticode signing (Azure Trusted Signing) before it ships to customers; unsigned pilot only on the owner's own machines.
- Session start-up: Cloudflare Worker + Durable Object signaling relay, with an agent-held hibernating "doorbell" WebSocket (new agent pip package `websocket-client` approved).

Standing repo guardrails that bind this plan (from .claude/CLAUDE.md):
- Never raise a UAC prompt unattended. Never block the agent's 5-second main loop. Never spawn reconnection logic outside `ConnectionManager`. Never import `firebase_admin`. Never log tokens. Never modify the `firebase` section of config.json remotely.
- `firestore.rules` and `agent/owlette_installer.iss` are not to be modified without explicit approval.
- A fleet-behaviour fix must cover the upgrade path from every fielded version (during self-update the OLD service and OLD desktop app are what run; the installer is the only new code that runs on an old box).
- Web: no direct Firestore calls from components (hooks only), no hardcoded colours, only lucide icons, all UI copy lowercase.
- No new npm/pip packages without confirmation (websocket-client and the Worker's own dev packages are the ones this plan asks for).

## 2. Contracts recovered from the lost original plan (keep stable — `dev/active/tri-platform-agent` references them)

- Rust crate at `agent/swoop`, binary `owlette-swoop.exe`. No cargo workspace. Own `.cargo/config.toml` with `+crt-static` (freshly imaged kiosks have no VC runtime). VERSIONINFO + icon via build.rs (an unsigned, stripped, metadata-free Rust PE is what Defender quarantined as Bearfoos.B!ml).
- Decision 3: the service spawns the streamer via `CreateProcessAsUser` with the **session bundle on stdin** (file fallback). Secrets never on the command line.
- Decision 12: no GPU requirement anywhere; hardware encoders where present, software floor on every OS.
- Task 2.2 = heartbeat keys `osFamily` / `arch` + `capabilities.swoop` (1 iff streamer binary present AND `streamer_capable()`), written as separate dotted keys. Task 2.5 = `.github/workflows/rust-build.yml`, one job step per crate with `working-directory:`. Task 0.11 = record the `live-view-webrtc` plan reversal. Spike 0.2 measures the MSRV floor. Wave 9 = `#[cfg]` seams for the macOS/Linux streamer backends (tri-platform Wave 8 builds them).
- Session store records `endReason`. Directories `ipc/swoop/`, `logs/swoop/`.

## 3. Architecture

```
browser (swoop page) --HTTPS--> owlette API (Next.js): authorize + step-up + audit, mint viewer JWT + ICE config,
        |                         ring the doorbell (HTTP to the Worker) AND enqueue a fallback command (polled 2-5 s)
        | WSS (viewer JWT)
        v
  swoop-signal: Cloudflare Worker + one Durable Object per machine (WebSocket hibernation)
        ^                         ^
        | WSS (host JWT)          | WSS (doorbell JWT), idle, hibernating
        |                         |
  owlette-swoop.exe  <--spawn, session bundle on stdin--  python agent service (session 0, LocalSystem)
  (SYSTEM token, active console session)

browser <==== WebRTC P2P over DTLS ====> owlette-swoop.exe
   data channels: video (unordered, unreliable), input-fast (unordered, unreliable: pointer moves),
                  input (reliable ordered: keys, buttons, wheel), control (reliable: clipboard, quality, presence, feedback),
                  cursor (shape reliable / position unreliable)
   RTP: Opus audio track (own MediaStream, never synced with video)
   fallback path: Cloudflare TURN (host-side allocation preferred; browser-side as stage 2)
```

Host pipeline: DXGI Desktop Duplication (per output; desktop-switch aware) → GPU convert/scale only when needed → encoder tier(s) → our framing → per-viewer sender (pacing + app-level rate governor) → data channel. Viewer feedback (per-frame arrival / decode / present timestamps, gaps) drives bitrate / fps / resolution and loss recovery (reference-frame invalidation or LTR where the encoder supports it, else IDR with a 250–500 ms cooldown).

## 4. Technical decisions (each with the reason and the evidence class)

T1. **Rust** for the streamer. Hot path is GPU silicon; no measurable C++ advantage. Memory safety matters for a SYSTEM process parsing network input. Toolchain already in repo (agent/host, Tauri). RustDesk proves Rust→vendor-SDK FFI at scale.

T2. **Process model**: agent service spawns `owlette-swoop.exe` on demand with its own SYSTEM token retargeted to the active console session (`DuplicateTokenEx` + `SetTokenInformation(TokenSessionId)` — primitive already exists as `_get_elevated_install_token()` in `owlette_service.py:2777`), `CreateProcessAsUser`, `lpDesktop=WinSta0\Default`, Job Object KILL_ON_JOB_CLOSE, stdin pipe for the bundle. One streamer per machine serves all viewers; lingers ~60 s after the last viewer leaves; exits. SYSTEM is required for secure-desktop capture/injection (login, lock, UAC) and for GPU scheduling priority. No elevation prompt is ever involved. Capture and input threads follow the input desktop with `OpenInputDesktop`/`SetThreadDesktop`; DDA is re-created on `DXGI_ERROR_ACCESS_LOST`. Ctrl+Alt+Del: streamer asks the service (file seam `ipc/swoop_commands/`), service calls `SendSAS(FALSE)`; service sets `SoftwareSASGeneration` policy when swoop is enabled.

T3. **Video path: encoded frames over an RTCDataChannel into WebCodecs, rendered to a canvas (primary).** Evidence: Parsec's web client does this; moonlight-web (Sept 2026) measures 26.8–30.3 ms LAN click-to-photon with it; Selkies and RustDesk moved off RTP media tracks to it; a `<video>` sink measured 35–45 ms slower than canvas (renderer-only comparison); Stadia measured 35–58 ms receiver-side on the media-track path; libwebrtc receivers offer no keyframe-free loss recovery (no RPSI, LNTF is VP8-only), while our own framing allows reference invalidation; **Edge has no H.265 in WebRTC at all**, but can decode HEVC via WebCodecs when hardware allows. Costs: we own pacing, rate control and loss recovery; SCTP sender limits (cwnd, RTO); DataChannel callbacks arrive on the main thread in Chrome (transferable DC is behind a flag). The RTP media-track path (`<video>`, playout-delay ext `min=0, max` in (0,500] ms — NOT `max=0`, which makes Chrome fast-forward and PLI) stays as the measured alternative: spike 0.2 runs both on one harness and the numbers decide. Known landmines already identified: NVENC H.264 must set `bitstreamRestrictionFlag=1, max_num_reorder_frames=0` (Chrome D3D11 decoder otherwise holds ~16 frames: 208 ms → 8 ms); VPS/SPS/PPS in-band with every IRAP; hardware WebCodecs decoders on macOS stall on a static desktop → host keeps a floor frame rate of tiny skip frames.

T4. **Transport library: str0m** (Rust, sans-IO). Verified at HEAD 2026-09-15: full RFC 7798 H.265 packetizer with Chrome interop on record, BWE that is a port of libwebrtc GoogCC, pacer, NACK/RTX, SCTP data channels, 12 fuzz targets, pure-Rust/CNG crypto. Gaps: no TURN client (fill with `turn-client-proto` + `turn-client-rustls`; estimated 3–6 engineer-weeks), no mDNS (resolve `.local` via the Windows resolver before handing candidates to str0m), no FEC, thin production evidence, unknown SCTP sender throughput ceiling. Runner-up: LiveKit `libwebrtc` crate (pre-encoded passthrough merged 2026-07, m150 with H.265, 114 MB prebuilt C++ blob — rejected as first choice because it would run as SYSTEM and pins us to someone else's milestone). Rejected: libdatachannel (no TURN-TCP/TLS, no ICE restart, UAF history), GStreamer (no playout-delay, 84 MB runtime, LGPL), Pion (Go sidecar), webrtc-rs (Pion-shaped GCC, no browser interop testing). Interim before host-side TURN lands: browser-side TURN allocation (works day one; fails only when the host network blocks all outbound UDP).

T5. **Codec ladder** HEVC Main 8-bit 4:2:0 → H.264 (with the VUI fix) → AV1 later. Chosen per viewer from a client capability probe (`VideoDecoder.isConfigSupported`, hardware preferred) ∩ host encoder availability. H.264 is a first-class path, not a nicety (Firefox <2% HEVC, Chrome HEVC is hardware-only with no software fallback, ~75% of Windows). Multi-viewer: one capture, up to two concurrent encoder tiers (codec tier and/or bitrate tier), encoded frames fanned out to N viewers; PLI/IDR requests coalesced and rate-limited; never Parsec's "one client downgrades everyone".

T6. **Capture**: DXGI Desktop Duplication primary (dirty rects, cursor shape API `GetFramePointerShape`, works as SYSTEM on the secure desktop). Windows.Graphics.Capture only as a user-token helper process if spike shows DDA failing on Win11 24H2/25H2 / independent-flip content. Never change display configuration (resolution, refresh, HDR, topology) without a per-machine opt-in — signage machines show their screen to the public.

T7. **Encoders** behind one trait: NVENC direct SDK first (ARGB in, on-chip CSC, true zero-copy; P1 + ultra-low-latency tuning + CBR + 1-frame VBV + infinite GOP + no B-frames + no lookahead; `NvEncInvalidateRefFrames`). Then **Media Foundation hardware MFT** as the universal Intel/AMD (and NVIDIA-fallback) backend — in-box, zero licence/packaging cost, `CODECAPI_AVLowLatencyMode`, LTR control. Then a software H.264 floor (MF software MFT or openh264 — not x264, which is GPL). Native AMF / oneVPL only if spike measurements show the MF path is materially slower.

T8. **Signaling**: Cloudflare Worker + Durable Object per machine with WebSocket hibernation. Browser is always the SDP offerer (recvonly audio + data channels; pre-generated before the host is up); host always answers; re-negotiation is "browser re-offers". JWTs are EdDSA, minted by the Owlette API (private key never leaves the API), verified by the Worker AND independently by the streamer (API public key arrives in the bundle). Viewer JWT claims: uid, site, machine, sid, viewer id, `ctl` (may control), `fp` = the browser's DTLS certificate fingerprint (browser generates its RTCCertificate first), exp ≤ 60 s, single-use jti. Host→browser authenticity: per-viewer key `k = HKDF(K_session, viewer id)`; `K_session` reaches the host in the bundle and `k` reaches the browser in the API response; the host MACs its DTLS fingerprint + sid with `k`; the relay never sees either key, so a compromised relay cannot MITM. The streamer holds no long-lived credential — only the bundle (host JWT, TURN creds, API public key, K_session), all short-lived.

T9. **NAT**: P2P first (host + srflx via `stun.cloudflare.com`). TURN = Cloudflare Realtime TURN. **Host-side allocation preferred**: Cloudflare bills only TURN-server→TURN-client egress, so when the host holds the allocation the video direction is unbilled (est. ~100× cheaper; to be validated with a metered session + the `callsTurnUsageAdaptiveGroups` GraphQL dataset, `customIdentifier` = site id). Relayed sessions capped at 25–30 Mbps (Cloudflare shapes allocations above ~50–100 Mbps / 5–10 kpps). TURN over TLS 443 gets a degraded mode (lower cap, no bursts). Relay→direct promotion by ICE restart a few seconds after connect. Agent service adds an inbound-UDP Windows Firewall allow rule for the exe when swoop is enabled.

T10. **Security posture**: new capability `MACHINE_REMOTE_CONTROL` (site admin/owner) for control; `MACHINE_VIEW` (members) can watch only; the host enforces `ctl` from the verified JWT, not from anything the viewer says. Site-level enable (default off) with per-machine exclude; step-up auth freshness check on control-session create; blocking audit row per session create (existing `authorizedSiteHandler` behaviour) + operational log events; kill switch (site, machine) that reaches a live streamer through the doorbell in < 2 s and through the polled command channel otherwise; session indicator on the host via the tray app watching `tmp/swoop_status.json` (on-screen indicator is a site policy because signage screens are public); TURN creds short TTL + revoked at session end; input rate limits and clipboard size caps on the host; control-protocol fuzz targets; Windows process mitigation policies on the streamer. Deferred hardening: split the streamer into a low-privilege network process and a SYSTEM capture/input process (the internal seam is designed for it from day one).

T11. **No firestore.rules change**: the session store `sites/{s}/machines/{m}/swoop_sessions/{sid}` is written only by the API (admin SDK) and read only by the API; the browser gets state from the API and live presence from the signaling room. A task verifies that no existing wildcard rule exposes the new subcollection, and the docs hold no secrets regardless.

T12. **Instrumentation first**: a latency harness (host-side flash target driven by a low-level mouse hook + client-side presented-pixel probe) exists before any pipeline code, and every frame carries capture/encode/send timestamps so the stats overlay can show a per-stage breakdown.

T13. **Release engineering**: bundled in the installer at `{app}\swoop\owlette-swoop.exe` (rides the existing self-update); installer pre-kills a running streamer by PID before replacing the file; Authenticode signing of every exe + the installer BEFORE the SLSA subject-hashing step in `build-installer.yml`; Rust CI is new (`rust-build.yml`).

T14. **Legacy live view** is removed when swoop ships (web modal, hooks, agent loop, command types, OpenAPI enum, CLI stub, docs). `/api/agent/screenshot` stays (crash screenshots and cortex use it). Machines on older agents show a disabled "swoop" item with an "update the agent" hint, gated on `capabilities.swoop`.

## 5. Latency budget we are planning against (1080p60, Chrome, NVENC)

input event 1–8 ms · ½RTT · inject <1 · host present 0–16.7 · capture 1–6 · convert 0–1 · encode 3.4–5.8 (budget 20–30 on a GPU-saturated TouchDesigner box) · packetize/pace 0.5–3 · ½RTT · jitter buffer 0 (data channel) · decode 1–12 · render 0.3–2 · compositor 16.7–33 @60 Hz (halved @120 Hz) · scanout ~8. Fixed non-network cost ≈ 45–55 ms ⇒ a 100 ms target leaves ~40–45 ms RTT; 50 ms is LAN + fullscreen + high-refresh only.

## 6. Waves (outline — task detail is written after review)

Convention to keep parallel tasks off the same file: scaffolding tasks create every module directory, stub file and dependency entry up front (Cargo.toml, mod declarations, toolbar slots), so later parallel tasks only fill their own files.

**Wave 0 — spikes (throwaway code in `agent/swoop/spikes/`, memos in `dev/active/swoop/spikes/`)**
- 0.1 latency harness (flash target app + browser presented-pixel probe + method doc)
- 0.2 video path + transport bake-off on this dev box (RTX 2080 Ti): DDA → NVENC (H.264 with VUI fix, HEVC) → str0m; path A data channel + WebCodecs + canvas vs path B RTP media track + `<video>` with playout-delay; LAN and impaired network (2% loss, 40 ms RTT, 10 ms jitter); SCTP sender throughput ceiling to 80 Mbps; ICE restart; MSRV floor; binary size. Pass: path A LAN click-to-photon p50 ≤ 35 ms; 50 Mbps sustained 60 s without send-buffer growth; single-frame-loss recovery ≤ 100 ms at RTT 40. If str0m fails, rerun on the LiveKit libwebrtc crate.
- 0.3 SYSTEM console-session spawn with stdin bundle + Job Object; capture and inject across Default↔Winlogon (lock, UAC, logon screen after reboot with nobody logged in); SendSAS via the service; prove no UAC prompt can be raised
- 0.5 signaling Worker + Durable Object (hibernation, EdDSA verify, room fan-out, doorbell ring over HTTP), hop latency, idle cost model for 1k/10k doorbells; python `websocket-client` doorbell thread prototype under ConnectionManager
- 0.6 Cloudflare TURN: credential mint, forced-relay sessions, host-side allocation prototype with `turn-client-proto` (UDP then TLS 443), billing-asymmetry validation, relay RTT delta, shaping at 30/50 Mbps
- 0.7 browser matrix: WebCodecs HEVC/H.264 support + real decode on Chrome/Edge/Safari/Firefox × Windows/macOS/Linux; macOS static-desktop stall with the floor-frame-rate workaround; multi-window soak at 2/4/6/8 streams; canvas `desynchronized` vs WebGPU vs 2D; keyboard lock / pointer lock / clipboard prompts
- 0.10 threat model + protocol security design
- 0.11 record the live-view-webrtc reversal (CLI stub pointer + its test + docs mention)
- Hardware-gated spikes placed one wave before they are needed so they do not block Wave 1: capture edge cases (TouchDesigner perform mode, 24H2/25H2, hybrid GPU, Mosaic, HDR, display off, RDP active, headless detection) → Wave 4; encoder breadth (MF hardware MFT on Intel/AMD/NVIDIA, software floor on a 4-core VM, LTR availability, giant-canvas downscale cost) → Wave 5; signing dry run (Azure Trusted Signing, placement before SLSA hashing, Defender submission) → Wave 2, with the owner starting Azure identity validation immediately because it has lead time.

**Wave 1 — contracts + scaffolds**: 1.1 protocol spec `agent/swoop/PROTOCOL.md` + golden vectors in `agent/swoop/testdata/`; 1.2 Rust crate scaffold (all deps, all module stubs, traits `capture::Source`, `encode::Encoder`, `transport::VideoSink`, `input::Injector`, verbs `run|probe|version`, logging to `logs/swoop/`, `scripts/sync-versions.js` learns the crate); 1.3 web foundations (`capabilities.ts` + `rateLimit.server.ts` + `apiKeyTypes.ts` + `versionUtils.ts` + `web/lib/swoop/protocol.ts` tested against the golden vectors); 1.4 signaling service `infra/swoop-signal/` (Worker, DO, JWT verify, vitest); 1.5 env manifest entries + `web/proxy.ts` (connect-src for the signal origin, `/swoop` in PROTECTED_PATHS).

**Wave 2 — agent integration, server libs, CI**: 2.1 `swoop_manager.py` + `swoop_spawn.py` + `shared_utils.py` paths (manager runs in its own thread; emits `log_event` session events); 2.2 capability heartbeat (`firebase_client.py`, `swoop_capability.py`); 2.3 doorbell client `swoop_doorbell.py` + `requirements.txt`; 2.4 web server libs `web/lib/swoop/{tokens,turn,sessionStore,policy}.server.ts`; 2.5 `rust-build.yml`; 2.6 build + installer (`build_installer_full.bat`, `build_installer_quick.bat`, `owlette_installer.iss` payload + pre-kill); 2.7 `swoop_commands.py` handlers; 2.8 signing dry-run memo.

**Wave 3 — core modules in parallel**: 3.1 agent wiring in `owlette_service.py` (manager thread, command registration) + integration test with a fake streamer; 3.2 user API routes `…/swoop/sessions` + `[sessionId]`; 3.3 agent API routes `…/api/agent/swoop/{bundle,doorbell-token}`; 3.4 internal command allowlist entries; Rust modules, one directory each: 3.5 capture/dda, 3.6 encode/nvenc, 3.7 gpu convert/scale, 3.8 transport (str0m, framing, pacing, governor), 3.9 signal (WSS client, JWT verify, fingerprint binding, admission), 3.10 input, 3.11 cursor; web libs: 3.12 signaling + peer, 3.13 video pipeline (reassembly, VideoDecoder, canvas, feedback, capability probe), 3.14 input + keymap.

**Wave 4 — first working session**: 4.1 Rust session orchestration (bundle parse, pipeline wiring, viewer lifecycle, linger, exit codes, status file, IDR/RFI policy, floor frame rate; pre-registers stub feature modules for Wave 5); 4.2 swoop page `web/app/swoop/[siteId]/[machineId]/{page,layout}.tsx` + `useSwoopSession` hook + stage/toolbar/stats components with stub slots; 4.3 dashboard entry (context-menu item gated on capability + online + site enablement; `window.open`); 4.4 capture edge-case spike. Gate: LAN session on the dev box meets the 0.2 thresholds end to end through the real signaling + API.

**Wave 5 — first-release features**: 5.1 secure desktop + Ctrl+Alt+Del (+ session-change respawn in `swoop_manager.py`); 5.2 clipboard (text + image, echo suppression, caps, paste interception); 5.3 audio (WASAPI loopback → Opus 10 ms → RTP track; starts muted); 5.4 displays (output picker, giant-canvas downscale policy, headless detection message); 5.5 quality menu + governor v2; 5.6 multi-user (presence, per-viewer permission enforcement, shared-input hygiene, other viewers' cursors); 5.7 encoder breadth spike.

**Wave 6 — every GPU**: 6.1 MF hardware MFT backend; 6.2 software H.264 floor; 6.3 encoder selection + fallback chain + `probe` verb; 6.4 encoder tiers for mixed viewers.

**Wave 7 — network + security hardening**: 7.1 host-side TURN client (UDP + TLS 443); 7.2 ICE policy (relay→direct promotion, network-change restart, mDNS resolve, stage-2 browser TURN); 7.3 relay caps + degraded mode + "relayed" indicator; 7.4 firewall rule + SAS policy side effects at enable/disable; 7.5 site enablement + kill switch (settings API/UI, Worker broadcast); 7.6 step-up auth on control-session create; 7.7 tray session indicator (`desktop/src-tauri`); 7.8 logs registry group + relayed-GB metering.

**Wave 8 — product integration + release**: 8.1 remove legacy live view (web); 8.2 remove legacy live view (agent); 8.3 API enum / OpenAPI / CLI `owlette swoop` / docs / changelog; 8.4 signing in `build-installer.yml`; 8.5 e2e (Playwright with an in-browser fake host peer feeding canned H.264 chunks; streamer `--source=testpattern --encoder=soft` mode for an agent-side integration test); 8.6 pilot on the owner's machines, measure success criteria, EDR allow-list doc, release per the build-system skill (version bump + changelog before building).

**Wave 9 — seams + deferred tracks**: 9.1 `#[cfg]` platform seams with non-Windows stubs that compile on CI; then, each only if its spike says so: virtual display driver (own sub-plan: IddCx, EV cert + attestation), WGC helper backend, RTP media-track path, native AMF/oneVPL. Backlog, not tasks: touch/mobile viewer, file transfer, SFU for N ≥ 4 viewers, UPnP opt-in.

## 7. Success criteria (draft)

- LAN, Chrome fullscreen, 1080p60, NVENC: input-to-photon p50 ≤ 35 ms, p95 ≤ 50 ms. WAN at RTT ≤ 40 ms: p50 ≤ 100 ms.
- Choose swoop → first frame p50 ≤ 1.5 s with a warm doorbell, ≤ 3 s relayed over TLS.
- Connects on: same LAN, srflx, TURN/UDP, TURN/TLS 443.
- Every GPU class and the software floor produce a stream; HEVC when both ends can, H.264 otherwise.
- Login screen after reboot with nobody logged in, lock screen, UAC prompt: visible and controllable; Ctrl+Alt+Del works.
- Three viewers with mixed codecs on one machine; view-only enforced by the host.
- Clipboard text + image both ways; audio with mute; cursor shape + position in sync; Cmd mapping.
- Default off; step-up enforced; audit rows present; kill switch ends a live session in ≤ 2 s (doorbell) / ≤ 7 s (poll).
- 5 s loop never blocked; no UAC prompt anywhere; screenshot paths and `/api/agent/screenshot` intact; agent suite, web unit tests and e2e green; upgrade from the oldest fielded version leaves a working swoop and never strands a streamer.
- Customer builds signed.

## 8. Known risks (draft)

1. App-level congestion control over SCTP is ours to build; SCTP sender ceilings in str0m are unmeasured.
2. str0m has thin production evidence and no TURN; TURN client is 3–6 weeks with an interop tail.
3. GPU-saturated TouchDesigner boxes push encode latency from ~5 ms to 20–30 ms.
4. EDR false positives for a SYSTEM binary that captures and injects.
5. Win11 24H2/25H2 Desktop Duplication regressions.
6. Browser hardware-decoder limits across several windows (HEVC has no software fallback).
7. Cloudflare billing-asymmetry assumption and per-allocation shaping.
8. Keyboard Lock is Chrome/Edge only; Safari/Firefox leak system shortcuts.
9. HEVC patent licensing position for a commercial product (hardware encoders/decoders normally cover it; needs counsel).
