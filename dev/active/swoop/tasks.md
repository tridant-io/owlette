# swoop — Tasks
**Progress**: 14/80 complete

Every task is executed by a fresh agent with no conversation context. Read [plan.md](plan.md) and
[context.md](context.md) first, then only the files your task names. Line numbers were read on `dev` at
`69422f9b` (2026-09-17) — re-locate by symbol if they have drifted. `dev/active/` is gitignored, so search it
with plain `grep -rn`, not ripgrep-based tools. Interface decisions made while drafting are recorded in
[drafting-notes.md](drafting-notes.md).

**Standing rules for every task**
- Tasks in one wave never touch the same file and never depend on each other. If you need a crate, stub, hook
  or interface that is missing, stop and log it here — do not add it yourself.
- Rust: run every cargo command with the working directory `agent/swoop` (never `--manifest-path`, which drops
  `.cargo/config.toml` and `+crt-static`). Done-when always includes `cargo clippy -- -D warnings` and
  `cargo test`. Hardware-dependent tests are `#[ignore]`d with the manual invocation in the module doc comment.
  `Cargo.toml` / `Cargo.lock` are edited only by Task 1.2 and Task 10.1. From Wave 5 on, feature tasks never
  edit `session/mod.rs`, `session/features.rs` or `main.rs` — the one exception is Task 9.1, which re-homes the
  Windows-only module declarations in `main.rs` behind `#[cfg(windows)]`.
- Web: `npx eslint <file>` clean on every file you touch; all UI copy lowercase; `lucide-react` icons only;
  theme tokens only; Firestore only through `web/hooks/`; no new npm packages in `web/`. From Wave 5 on, feature
  tasks never edit the swoop page or `useSwoopSession`.
- Never block the agent's 5-second loop. Never raise a UAC prompt. Never log tokens, keys or bundles. Never
  modify `firestore.rules`. swoop never changes display configuration without a per-machine opt-in. The doorbell
  never calls `ConnectionManager.register_thread` / `report_error`.
- Labels: `[agent]` runs on this dev box (RTX 2080 Ti, two monitors); `[human]` needs the owner's hardware,
  accounts, reboots or eyes — the task says exactly what the human does.
- Gates: **G1** after Task 0.2 (owner signs the memo before Wave 1) · **G2** after Wave 4 · **G3** after Wave 5
  (internal pilot) · **G4** in Task 10.1 (release, Wave 10).

## Wave 0: spikes and design memos

- [x] **Task 0.1: Latency harness + measurement contract** `[agent+human]`
  - Files: `agent/swoop/spikes/latency-target/**` (create: Rust bin + own `Cargo.toml` carrying an empty `[workspace]` table so a future parent workspace cannot absorb it), `agent/swoop/spikes/latency-probe-web/**` (create: static page + a tiny node http server that receives the page's JSON and writes it to disk), `dev/active/swoop/spikes/0.1-latency-harness.md` (create)
  - Do: Build the instrument and write the contract; build no pipeline. `latency-target`: a Win32 exe with a `WH_MOUSE_LL` hook (`SetWindowsHookExW` + message pump) that on button-down flips a borderless fullscreen window between two high-contrast colours and appends the `QueryPerformanceCounter` tick to a CSV. `latency-probe-web`: a page that samples presented pixels, computes p50/p95 over the run, and POSTs its JSON to the local server so the agent can read numbers without a human reading a screen. Then write the measurement contract `research/review-1-latency.md` F3 demands, and calibrate it on this box: host-local input→flip→photon, and the QPC↔`performance.now()` offset (NTP-style exchange, `research/review-3-delivery.md` F12). Publish the term the harness cannot see (compositor + scanout) as a fixed additive constant so every later number is comparable. Do not read a `desynchronized` canvas through `drawImage` — it reads back empty (review-1 F7); read the renderer's own pixels or use the camera. Do not create any product file under `agent/swoop/`.
  - Human: films the host and client monitors in one frame with a ≥ 240 fps slow-motion camera (a phone's slow-mo is acceptable if its frame rate is recorded) or wires a photodiode; supplies the ≥ 120 Hz monitor row or records that the hardware is not here yet.
  - Done when: `dev/active/swoop/spikes/0.1-latency-harness.md` exists and (a) defines, in writing, renderer-visible number vs photon number, real LAN hop vs same-machine (same-machine is ranking only, never an absolute product latency), the QPC↔`performance.now()` offset method, n ≥ 100 per series, p50 and p95, and separate rows for a 60 Hz and a ≥ 120 Hz client; (b) reports the calibration numbers with n and the fixed compositor+scanout term; (c) ends with a recommendation on which rows the G1 memo must report; (d) `cargo clippy -- -D warnings` and `cargo test` pass with the working directory set to `agent/swoop/spikes/latency-target`.
  - Blocks: 0.2 reports its G1 numbers in these terms; plan.md's success-criteria latency rows; D16 instrumentation; Tasks 3.12, 4.7 and gate G3.

- [x] **Task 0.2: Video-path + transport bake-off → gate G1** `[agent+human]`
  - Files: `agent/swoop/spikes/bakeoff-host/**` (create: Rust, own `Cargo.toml` with an empty `[workspace]` table and its own `Cargo.lock`), `agent/swoop/spikes/bakeoff-web/**` (create: page + local http server that receives per-run JSON), `dev/active/swoop/spikes/0.2-video-path-bakeoff.md` (create)
  - Do: One harness, three arms behind one trait (shape it like `transport::VideoSink` / `web/lib/swoop/video/receiver.ts` but create neither product file). Shared front half: DXGI Desktop Duplication → NVENC **H.264 with the VUI fix** (`bitstreamRestrictionFlag=1`, `max_num_reorder_frames=0`) **and HEVC**. Arms per plan.md D3: **A** encoded frames over an `RTCDataChannel` → WebCodecs → canvas, fragmented at ~1200 B, running the reliability-mode matrix `{ordered + maxPacketLifeTime 33–50 ms}` vs `{unordered, maxRetransmits: 0}` vs `{unordered + lifetime}` (`review-1-latency.md` F2), on str0m with the `sctp-proto` patches documented in the memo (review-1 F1 lists the hostile constants — 128 KiB shared buffer cap, 4380 B cwnd, `RTO_MIN` 1000 ms, no `max_burst` — with file:line); **B** RTP track → `<video>` with playout-delay `min=0, max ∈ (0, 500] ms` — never `max=0`; **C** the same sender with a receive-side `RTCRtpScriptTransform` → WebCodecs → canvas. Networks: LAN and impaired (2% loss, 40 ms RTT, 10 ms jitter); name the impairment tool, version and parameters in the memo. `research/05-transport-bakeoff.md` §7 has the spike design and getStats list; §5 has Chrome's receive-side requirements. Copy 0.1's harness if it exists but do not wait on it: carry per-frame host QPC stamps plus client arrival/decode/present stamps, and use the on-screen-clock + camera method for the photon row. Run the LiveKit `libwebrtc` arm only if str0m fails outright. Build no TURN, FEC, simulcast or reference invalidation.
  - Human: launches the impairment tool from an elevated console (explicit click — no agent path may elevate), runs the camera pass, and signs off the G1 recommendation.
  - Done when: `dev/active/swoop/spikes/0.2-video-path-bakeoff.md` exists and reports, as numbers with n: photon p50/p95 per arm on LAN and impaired, in 0.1's terms; the D3 decision rule applied explicitly (winner beats B by ≥ 15 ms p50 photon on LAN and does not lose to B at 2% loss / 40 ms RTT; ties go to the simpler path, B < C < A); **zero** `Channel::write()` → `Ok(false)` in a 60 s 50 Mbps run; measured goodput at 0 / 1 / 2% loss; single-frame-loss recovery time; ICE restart works; MSRV floor; release binary size; host CPU at 1 and 4 peers; cold-cache `windows-latest` build time (`review-3-delivery.md` F8). `cargo clippy -- -D warnings` and `cargo test` pass with the working directory set to `agent/swoop/spikes/bakeoff-host`. The memo's last section is the G1 recommendation with the numbers behind it, marked awaiting owner sign-off.
  - Blocks: **gate G1** — Tasks 1.1, 1.2, 2.5, 2.6, 3.8, 3.10, 3.11 and the Wave 9 second-video-path track are all written against the winner; 0.2's build time sets the `build-installer.yml` timeout.

- [ ] **Task 0.3: SYSTEM console-session spawn with pipes + secure desktop** `[agent+human]`
  - Files: `agent/swoop/spikes/spawn-py/**` (create: python driven by `agent/.venv/Scripts/python`, no imports from `agent/src`), `agent/swoop/spikes/securedesk/**` (create: Rust child, own `Cargo.toml` with an empty `[workspace]` table), `dev/active/swoop/spikes/0.3-system-spawn-secure-desktop.md` (create)
  - Do: Prove the six primitives plan.md D2 rests on. (1) The service's own SYSTEM token duplicated and retargeted to the active console session — the exact technique in `_get_elevated_install_token` (`agent/src/owlette_service.py:2777`): `OpenProcessToken` → `DuplicateTokenEx(TokenPrimary)` → `SetTokenInformation(TokenSessionId)` → `CreateEnvironmentBlock`. (2) `CreateProcessAsUser` with `lpDesktop = WinSta0\Default`, `bInheritHandles=TRUE`, `STARTF_USESTDHANDLES`, and **only** the two anonymous pipe handles in the `STARTUPINFOEX` `PROC_THREAD_ATTRIBUTE_HANDLE_LIST` — `_launch_command_as_user` (`:2829`, `bInheritHandles=0` at `:2851`) cannot do this, which is why swoop gets its own helper. Carry a bundle-shaped JSON line on stdin and a `ready` event line on stdout, then `{"type":"kill"}` in and `exiting` out (names registry). (3) Job Object `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`. (4) Capture and `SendInput` across Default↔Winlogon via `OpenInputDesktop`/`SetThreadDesktop` on a dedicated thread, recreating the D3D11 device and duplication on `DXGI_ERROR_ACCESS_LOST`. (5) `SendSAS(FALSE)` from a LocalSystem context with `HKLM\SOFTWARE\Microsoft\Windows\CurrentVersion\Policies\System\SoftwareSASGeneration = 3`; record the prior value (including "absent") and restore it at the end. (6) That no path can raise a UAC prompt. `research/03-windows-host-stack.md` §1.4, §7.3, §7.4, §11.1 and §11.2 hold the detail. State in the memo how the prototype is run as SYSTEM non-destructively: the human opens an elevated console and registers a temporary `schtasks /RU SYSTEM` task (the `owlette_service.py:4980-5079` pattern), runs it, deletes it. Never `net stop OwletteService`, write into `C:\ProgramData\Owlette`, `runas`/ShellExecute-elevate from code, or put a secret on a command line; do not create `agent/src/swoop_spawn.py` (Task 2.1 owns it).
  - Human: the elevated console, the lock (Win+L), the UAC consent prompt, and a reboot to the logon screen with nobody logged in; eyes on whether the secure desktop is visible and controllable.
  - Done when: `dev/active/swoop/spikes/0.3-system-spawn-secure-desktop.md` records an observed pass/fail plus a number for each of the six, specifically: the pipe handoff round trip in ms, the handle-list check showing exactly two inherited handles, desktop-switch → first recovered frame after `ACCESS_LOST` in ms for lock / UAC / logon screen, the SAS result, and a written statement that no UAC prompt is raisable with the evidence for it. The restored `SoftwareSASGeneration` state is pasted from `reg query`. The temporary scheduled task is deleted. `cargo clippy -- -D warnings` and `cargo test` pass with the working directory set to `agent/swoop/spikes/securedesk`. The memo ends with a recommendation on the spawn-helper shape for Task 2.1.
  - Blocks: Tasks 2.1 (spawn helper + SwoopManager), 4.3 (input injection), 6.1 (secure desktop + Ctrl+Alt+Del), 7.7 (enable/disable side effects), and the "no UAC prompt anywhere" success criterion.

- [x] **Task 0.4: Signaling Worker + doorbell prototype** `[agent]` (+`[human]` for deployed numbers)
  - Files: `agent/swoop/spikes/signal-worker/**` (create: wrangler project with its own `package.json` and `wrangler.toml`), `agent/swoop/spikes/doorbell-py/**` (create: own venv + `requirements.txt` pinning `websocket-client` with a reason comment; no imports from `agent/src`), `dev/active/swoop/spikes/0.4-signaling-doorbell.md` (create)
  - Do: Stand up a Worker plus one Durable Object per machine on the **WebSocket hibernation API** (`ctx.acceptWebSocket`, `serializeAttachment` ≤ 16,384 B, auto-pong, unbilled protocol pings — `research/04-nat-turn-signaling.md` §4.3). Routes and message names come from the names registry: `GET /health`, `GET /v1/room/{siteId}/{machineId}` (WS), `POST /v1/ring`, `POST /v1/kill`; messages `hello`, `ring`, `viewer-join`, `host-ready`, `offer`, `answer`, `candidate`, `kill`, `bye`, `error`. Verify EdDSA JWTs with `kid` through WebCrypto and record the exact algorithm identifier workerd accepts for Ed25519; accept **two** active public keys so rotation is not a flag day (`review-3-delivery.md` F6.3). Derive the Durable Object name from the token's `machine` claim, **never** from a client-supplied room id (`review-2-security.md`, "sections that held up"), and apply a per-machine ring cap (review-2 M5). Prove room fan-out and `POST /v1/ring` waking an idle doorbell socket. On the python side, a daemon thread dialling the room with a doorbell JWT and printing ring→callback latency. Run it all on local `wrangler dev`. Never log a JWT, a key or a bundle, not even partially; do not touch `agent/requirements.txt`; do not create `infra/swoop-signal/` (Tasks 1.4 / 2.8 own it); generate test keys inside the spike directory and read no `.env*` or `.claude/.env.local`.
  - Human: deploys the spike Worker to the owner's Cloudflare account (a long-lead item in plan.md) and re-runs the hop-latency pass from this box against the real edge, recording the DO home-location effect.
  - Done when: `dev/active/swoop/spikes/0.4-signaling-doorbell.md` reports, with n: hop latency p50/p95 browser→DO→doorbell locally and (if the account exists) deployed; the workerd Ed25519 algorithm name; a demonstrated `POST /v1/ring` → python callback with a ring-flood result against the cap; and an idle-cost model for 1,000 and 10,000 permanently-connected doorbells computed line by line from the pricing figures in `research/04-nat-turn-signaling.md` §4.3 (20:1 incoming-message billing, hibernation duration-free, per-request and GB-s rates). `npx wrangler dev` starts clean and the spike's own tests pass. The memo ends with a recommendation for Task 1.4's Worker shape.
  - Blocks: Tasks 1.4, 2.3, 2.8, 3.4 and 3.9; the "first frame p50 ≤ 1.5 s with a warm doorbell" criterion.

- [x] **Task 0.5: Threat model + protocol security design** `[agent]`
  - Files: `dev/active/swoop/spikes/0.5-threat-model.md` (create). No code.
  - Do: Write the threat model for swoop as designed. Enumerate assets (session bundle, `SWOOP_JWT_PRIVATE_KEY`, `SWOOP_SESSION_MASTER_KEY`, `K_session` and per-viewer `k`, TURN credentials, the desktop pixels and the input channel themselves), actors (unauthenticated internet, read-only site member, site admin, API-key holder, local standard user on a kiosk, compromised relay, compromised single agent), and trust boundaries: browser↔API, API↔Worker/DO, Worker↔streamer, service↔streamer (the anonymous pipes), streamer↔browser DTLS, and the install tree on disk. For each boundary give the threats and then show precisely how plan.md **D8–D12** answer them. Carry across **every accepted finding** in `research/review-2-security.md` — C1, C2, H1–H5, M1–M8, L1–L5 — each with its disposition (adopted in decision D-x, owned by task y, or accepted risk with a reason), and do not re-file a settled decision as a discovery. Close with residual risks. Every finding cites file:line. Follow the repo's review-discipline rules: a critical claim needs actor, mechanism and outcome written out, and the full severity ladder is used. Do not modify `firestore.rules` — D12's position is that no change is needed and the memo records the evidence (`firestore.rules:940` catch-all, the only recursive wildcard at `:247`).
  - Done when: `dev/active/swoop/spikes/0.5-threat-model.md` exists with the sections above; every review-2 finding id appears exactly once with a disposition; and the **final section is a security block ready to paste verbatim into `agent/swoop/PROTOCOL.md`** at Task 1.1, covering at minimum: `fp` mandatory with the two negative golden vectors (token without `fp` rejected; `fp` not matching the offer's `a=fingerprint:` rejected); `exp` verified against the bundle's time anchor plus monotonic elapsed, never the kiosk clock; `kid` with a two-key overlap and the defined behaviour on an unknown `kid`; the weight statement putting the defence on `fp` + `exp` rather than `jti`; `k = HKDF(K_session, viewerId)` with `K_session = HKDF(SWOOP_SESSION_MASTER_KEY, sid)`, derived and never stored; and the sid-only contract for the doorbell ring and the Firestore command.
  - Blocks: Task 1.1 (PROTOCOL.md + golden vectors), 1.3, 1.4, 3.2, 3.3, 5.4, 5.5 and the Wave 8 negative e2e tests.

- [x] **Task 0.6: Doorbell supervision design** `[agent]`
  - Files: `dev/active/swoop/spikes/0.6-doorbell-supervision.md` (create). No code.
  - Do: Design the self-supervision that plan.md's owner ruling makes a documented exception to "never spawn reconnection logic outside `ConnectionManager`". Specify: the state machine (idle → dialling → connected → backoff → circuit-open → disabled-slow → shutdown) with every transition; backoff base, cap, full-jitter rule, failure threshold and half-open probe, chosen as numbers and justified; doorbell-token lifecycle against `POST /api/agent/swoop/doorbell-token`, refresh margin before `exp`, and re-dial on 401; the 403 `swoop_disabled` slow-retry path (name the interval) and how the `swoop_refresh` command forces an immediate re-dial; and thread lifecycle — a daemon thread that observes the service's shutdown path (`owlette_service.py:1397 graceful_shutdown`, `_scm_stop_requested` `:907`/`:1934`) and never blocks the 5-second loop (`SLEEP_INTERVAL = 5`, `owlette_service.py:82`). State that it may *read* `connection_manager.state` to avoid dialling while the machine is offline. Cite the lines that make registration forbidden: `connection_manager.py:698` `register_thread`, watchdog `:765-786`, `report_error` `:436-472`, `FAILURE_THRESHOLD` `:210`, `BACKOFF_BASE`/`BACKOFF_MAX` `:205-206`, `WATCHDOG_INTERVAL` `:217` — a dead supervised thread cycles the **Firestore** connection, so a Cloudflare outage would hit the whole fleet (`review-3-delivery.md` F1). Never log tokens. Write no code and create no `agent/src/swoop_doorbell.py` (Task 2.3 owns it).
  - Done when: `dev/active/swoop/spikes/0.6-doorbell-supervision.md` exists with every parameter given as a number and a reason; a state-transition table; a token-refresh timeline; and a **test plan** whose headline case is: with the signalling origin unreachable for 10 minutes, the agent's `ConnectionState` never leaves CONNECTED and no additional Firestore reconnect is logged — expressed as named cases for `agent/tests/unit/test_swoop_doorbell.py`, which Task 2.3 will write. The memo ends with a recommendation and the reasoning behind the chosen backoff numbers.
  - Blocks: Tasks 2.1 and 2.3; the "a 10-minute signalling outage leaves the agent's Firestore connection CONNECTED" success criterion.

- [x] **Task 0.7: Install-directory + uninstall-cleanup inventory** `[agent]`
  - Files: `dev/active/swoop/spikes/0.7-install-dir-cleanup.md` (create). No code, no repo file modified.
  - Do: First, **read-only**: record the ACLs of this machine's live install with `icacls` for the directories swoop touches (`C:\ProgramData\Owlette` and its `tools`, `agent`, `app`, `python`, `ipc`, `tmp`, `logs`, `config` and `cache` subdirectories), and settle whether ACEs set by the installer's `[Dirs]` section (`agent/owlette_installer.iss:197-203`) are inherited by directories and files created later by `[Files]` and by `os.makedirs`. Then specify, without writing code: the protected DACL for `{app}\swoop` — SYSTEM:F, Administrators:F, Users:RX, inheritance disabled — modelled on the working pattern at `agent/src/display_manager.py:315-372` (`SetNamedSecurityInfo` with `PROTECTED_DACL_SECURITY_INFORMATION`, plus a `_ipc_dir_dacl_matches`-style idempotence check), applied from the installer **and** re-asserted at service start, as a hard gate (spawn refuses, streamer refuses) rather than best effort. Next, the `.iss` kill-pass semantics: kill by name scoped to the install path exactly as the desktop-app block at `:1176-1183` does, never by PID; the silent-mode delay-until-reboot consequence of a miss (`:1155-1160`); and the version handshake that makes a stale binary safe (agent refuses a streamer whose `version` differs — exit code 11). Then `SetDefaultDllDirectories(LOAD_LIBRARY_SEARCH_SYSTEM32)` + `SetDllDirectory("")` with every vendor DLL loaded by absolute path (`dxgi.dll`, `d3d11.dll`, `nvEncodeAPI64.dll`, `avrt.dll`, `sas.dll`). Finally the uninstall cleanup inventory. Do not edit `agent/owlette_installer.iss` — it is a guardrailed file and Tasks 2.6 / 7.7 carry the owner-acked edits. Change no ACL and write nothing into the installed tree.
  - Done when: `dev/active/swoop/spikes/0.7-install-dir-cleanup.md` exists with the pasted `icacls` evidence and a yes/no answer on ACE inheritance; the exact DACL specification and where it is applied; the kill-pass and version-handshake semantics; the DLL-search hardening; and an uninstall cleanup inventory naming the firewall rule string and its `New-NetFirewallRule` shape, the `SoftwareSASGeneration` prior-value capture and restore (including "absent" as a restorable state), and the directories to sweep (`{app}\swoop`, `logs\swoop`, `ipc\swoop`) with their `[UninstallRun]` / `[UninstallDelete]` placement. The memo ends with a recommendation and states which items are prerequisites of the separate install-directory security release that gates G4.
  - Blocks: Tasks 1.5, 2.6, 7.7 and gate G4.

- [x] **Task 0.8: Capture probe** `[agent]`
  - Files: `agent/swoop/spikes/capture-probe/**` (create: Rust bin, own `Cargo.toml` with an empty `[workspace]` table), `dev/active/swoop/spikes/0.8-capture-probe.md` (create)
  - Do: Measure DXGI Desktop Duplication on this box (two monitors plus the Parsec Virtual Display Adapter), running as the ordinary interactive user — no elevation, no service involvement. Enumerate every `IDXGIAdapter`/`IDXGIOutput` and report exactly what the Parsec virtual adapter does to enumeration and whether it forces a second capture device (DDA requires the capturing device on the same adapter as the output — `research/03-windows-host-stack.md` §1.1). Then per output: `IDXGIOutput1::DuplicateOutput` / `IDXGIOutput5::DuplicateOutput1`; the `AcquireNextFrame` pacing pattern against DWM (inter-frame interval histogram at timeouts 0 / 1 / 8 / 16 ms — is it vsync-locked?); `GetFrameMoveRects` then `GetFrameDirtyRects` (all move rects before all dirty rects) with counts and coverage on a static desktop, a dragged window and a scrolling page; `GetFramePointerShape` plus `PointerPosition` and `LastMouseUpdateTime == 0`, recording shape type, dimensions and hotspot; static-desktop behaviour as the `DXGI_ERROR_WAIT_TIMEOUT` rate over 60 idle seconds; and `DXGI_ERROR_ACCESS_LOST` — force it with a mode change and with a lock, then measure recreate → first frame. Also record surface format, rotation behaviour, per-output DPI and the virtual-desktop origin, including any negative coordinates (`review-3-delivery.md` F12). Do not implement encode, transport or injection; do not copy any spike binary into `C:\ProgramData\Owlette`.
  - Done when: `dev/active/swoop/spikes/0.8-capture-probe.md` reports every item above as a number with n (histograms as tables), names the Windows build and GPU driver version the run was made on, and ends with a recommendation for Task 3.6 covering the pacing pattern to adopt, the ACCESS_LOST recovery sequence, and whether the Parsec virtual adapter must be filtered out of the output list. `cargo clippy -- -D warnings` and `cargo test` pass with the working directory set to `agent/swoop/spikes/capture-probe`.
  - Blocks: Tasks 3.6 (capture), 4.4 (cursor), 5.7 (capture edge-case spike), 6.4 (displays).

- [x] **Task 0.9: NVENC configuration validation** `[agent]`
  - Files: `agent/swoop/spikes/nvenc-probe/**` (create: Rust bin + a static page and tiny local http server for the WebCodecs check; own `Cargo.toml` with an empty `[workspace]` table), `dev/active/swoop/spikes/0.9-nvenc-config.md` (create)
  - Do: Validate the encoder settings plan.md D5/D7 assert, on this box's RTX 2080 Ti. Configure NVENC as specified: preset P1, ultra-low-latency tuning, CBR, one-frame VBV (`vbvBufferSize = bitrate / fps`, `vbvInitialDelay` equal), infinite GOP, no B-frames, no lookahead, async encode with depth 1, **single slice**, `B8G8R8A8`/ARGB fed straight in with no shader (`research/03-windows-host-stack.md` §2.2). Measure: (1) the H.264 VUI fix — emit with and without `bitstreamRestrictionFlag=1` + `max_num_reorder_frames=0`, feed both Annex-B streams into a Chrome `VideoDecoder` through WebCodecs from the local page, which POSTs chunk-in→frame-out counts and submit→output milliseconds back to the spike's http server; (2) forced-IDR latency, request → IDR emitted; (3) bitrate reconfigure without an IDR (`NvEncReconfigureEncoder` with no reset) — confirm by parsing the NAL stream; (4) single-slice output confirmed by NAL parsing; (5) HEVC VPS/SPS/PPS present in-band on **every** IRAP; (6) encode latency p50/p95 at 1080p60 and 4K60. Do not build reference-frame invalidation or LTR (deferred — `review-1-latency.md` F4) and do not enable intra-refresh (it makes every frame multi-slice, and Chromium now hard-fails a damaged HEVC picture). Do not copy any spike binary into `C:\ProgramData\Owlette`, and list every crate the spike pulls in — the licence and advisory gate is Task 2.5's, not this spike's.
  - Done when: `dev/active/swoop/spikes/0.9-nvenc-config.md` reports all six as numbers with n, states the driver version and SDK version used, and shows the VUI result as a before/after pair (the claim under test is ~208 ms → ~8 ms). `cargo clippy -- -D warnings` and `cargo test` pass with the working directory set to `agent/swoop/spikes/nvenc-probe`. The memo ends with a recommendation: the exact settings struct Task 3.7 should ship, and any setting the measurement contradicts.
  - Blocks: Tasks 3.7 (NVENC), 4.5 (GPU convert/scale), 4.7 (governor), 6.5 (quality + resolution change), 6.7 (encoder breadth spike).

- [ ] **Task 0.10: Web presentation probe** `[agent+human]`
  - Files: `agent/swoop/spikes/present-probe-web/**` (create: static page, worker scripts and a tiny local node http server that receives per-run JSON; its own `package.json` only if one is genuinely needed), `dev/active/swoop/spikes/0.10-web-presentation.md` (create)
  - Do: Settle plan.md D17's presentation contract empirically, browser-side only — no host, no Rust. Use a same-page loopback `RTCPeerConnection` pair and locally generated encoded chunks. Measure: (1) present from the `VideoDecoder` output callback vs from `requestAnimationFrame`, over 60 s at 60 fps into this box's panel, counting dropped and duplicated presents — use `requestVideoFrameCallback`'s `presentedFrames` and `expectedDisplayTime` only to measure, never to schedule; (2) `desynchronized` canvas vs WebGPU `importExternalTexture` vs canvas 2D `drawImage` vs `ImageBitmapRenderingContext`, reporting submit→present and throughput, and confirming the `desynchronized` readback-empty behaviour that constrains telemetry (`review-1-latency.md` F7); (3) decode in a worker with `OffscreenCanvas`, including whether `desynchronized` and OffscreenCanvas-in-a-worker combine (`research/02-browser-client.md` §2.4 says this is undocumented); (4) **whether transferable `RTCDataChannel` is available in stable Chrome today** — `research/01-parsec-and-peers.md:1002` says developer trial behind a flag at M130, `review-1-latency.md:300-305` says shipped at M130; transfer a channel to a dedicated worker and record the exact Chrome version and result; (5) receive-side `RTCRtpScriptTransform` — where in the pipeline frames appear relative to libwebrtc's frame buffer, and what happens when frames are **not** written back (watch `getStats()` `pliCount`). Call `frame.close()` immediately everywhere. Do not `npm install` into `web/` and do not create anything under `web/lib/swoop/` (Tasks 1.3 / 2.9 / 3.11 own it).
  - Human: runs the same page on Safari (macOS) and Firefox and reports the same fields, since neither browser is on this box.
  - Done when: `dev/active/swoop/spikes/0.10-web-presentation.md` reports every item as a number with n, per browser and version, with an explicit one-line verdict on the transferable-`RTCDataChannel` disagreement naming which source was right; and ends with a recommendation for the presentation stack Task 3.12 should ship, including the fallback order and what Firefox loses.
  - Blocks: Tasks 3.11, 3.12 and 2.12 (browser matrix spike); informs the interpretation of 0.2's arm C, but 0.2 does not wait on it.

- [x] **Task 0.11: Record the live-view-webrtc reversal** `[agent]`
  - Files (all modify): `cli/src/commands/machine.ts` (the stub at `:427-442` — `reason` and `futurePlan` — plus the header comment at `:14-15`), `cli/__tests__/commands/stubs.test.ts` (fixture `futurePlanSubstr` at `:42`; the assertions at `:108` and `:138` read that fixture and need no edit), `cli/__tests__/commands/readiness-docs.test.ts` (`:60`), `web/content/docs/cli/readiness.mdx` (`:60`), `web/content/docs/cli/overview.mdx` (`:165`, `:234`), `web/content/docs/cli/reference/machine.mdx` (`:3`, `:133`, `:147-149`, `:152`)
  - Do: The deferred CLI stub still points at the abandoned `live-view-webrtc` plan; repoint it at swoop. Replace the `futurePlan` value `public-api deferred: live-view-webrtc` with `public-api deferred: swoop` and reword `reason` so it says remote desktop is shipping as swoop and the verb lands with it. Keep the verb name `live-view`, the exit code 3, the envelope keys and the `stubExit` shape exactly as they are — a `swoop` CLI verb is Task 8.5's, not this one's. Then move every place that pins the old string in lockstep: the test fixture, `readiness-docs.test.ts:60`, and the four doc lines. All copy is lowercase per the repo's UI-copy rule. Note the trap in `readiness-docs.test.ts:38-49`: it forbids `dev/active/live-view-webrtc` appearing in CLI docs, so the replacement must not introduce `dev/active/swoop` either — reference the feature, not the plan directory. Do not touch `docs/internal/public-api-developer-preview-checklist.md`, do not add a new CLI command, and do not change `cli/bin/owlette` (it has uncommitted local changes).
  - Done when: `cd cli && npm test` passes (both `stubs.test.ts` and `readiness-docs.test.ts` green), `cd cli && npm run lint` and `cd cli && npm run build` are clean, `grep -rn "live-view-webrtc" cli/ web/content/` returns only `cli/__tests__/commands/readiness-docs.test.ts:40`, the stale-needle guard, which stays as it is, and `owlette machine live-view m-1 --site s-1 --json` still exits 3 with `ok:false, stub:true` and a `future_plan` naming swoop.
  - Blocks: nothing in Wave 0; closes the recovered contract "Task 0.11 = record the live-view-webrtc reversal" and stops Task 8.5 inheriting a stale pointer.

## Wave 1: contracts and scaffolds

- [x] **Task 1.1: PROTOCOL.md + golden vectors** `[agent]`
  - Files: `agent/swoop/PROTOCOL.md`, `agent/swoop/testdata/protocol/index.json`, `agent/swoop/testdata/protocol/**` (JSON + binary vectors, including the five negative ones: a viewer JWT with no `fp`, a JWT expired against the time anchor, a JWT for the wrong machine, a frame chunk with a dangling reference, a version-mismatch handshake), `agent/swoop/testdata/keymap.json`
  - Do: Write the wire contract every later task is built against. Sources: `plan.md` (D2, D5, D8, D9, names
    registry), the G1 and threat-model memos in `dev/active/swoop/spikes/`,
    `research/review-2-security.md` (C2, M3, M4). Sections: protocol-version handshake; the ten signaling
    messages with per-role send rights; channel/track layout for the G1 winner; the binary frame header (field
    layout, endianness, frame id, IRAP flag, codec, resolution, capture/encode/send timestamps, fragment
    index/count; never a chunk with a dangling reference); input/cursor/clipboard/control/feedback
    messages; the stdin/stdout pipe protocol with exit codes 0/10/11/12/13/14/20; the bundle schema (JWT public
    key + `kid`, time anchor, ICE servers, enablement, `indicator`, `ctl`, `streamerEpoch`, plus an optional
    test-only `overrides` object — `{source?: "testpattern", encoder?: "soft"}` — which a streamer built
    without the `testhooks` cargo feature must **reject** with exit 10), marked never-logged; JWT claims
    and verification order (signature → `kid` → `aud`/`iss` → `exp` against the bundle time anchor plus
    monotonic elapsed, never the kiosk clock → mandatory `fp` → site/machine match → `jti`); the fingerprint MAC
    with exact HKDF salt/info/length and MAC input layout; 5-minute lease renewal, 12 h cap, host behaviour on a
    missed renewal; a security section — ring and fallback command carry an opaque `sid` and nothing else, no
    file fallback, `K_session` derived and never stored. `index.json` maps each vector to
    `{kind, expect: "accept"|"reject", reason}` — the manifest Tasks 2.9 and 2.10 both iterate, so its shape is
    contract. `keymap.json` maps every standard `KeyboardEvent.code` to `{scancode, extended}`, numpad,
    left/right modifiers and the PrintScreen/Pause quirks included. No Rust, no TypeScript here.
  - Done when: `PROTOCOL.md` covers all eleven sections above; `node -e "JSON.parse(require('fs').readFileSync('agent/swoop/testdata/protocol/index.json','utf8'))"` succeeds and every file it names exists; every vector has an `expect` and a `reason`; the five negative vectors are present and marked `reject`; `keymap.json` parses and contains no duplicate `code` keys; no secret, token or key material appears in any committed vector (use obviously fake key material and say so in the file).
  - Depends on: 0.2 (G1 memo signed off), 0.5 (threat model memo)

- [x] **Task 1.2: Rust crate scaffold + core types** `[agent]`
  - Files: `agent/swoop/Cargo.toml`, `agent/swoop/Cargo.lock`, `agent/swoop/.cargo/config.toml`, `agent/swoop/build.rs`, `agent/swoop/src/**`, `scripts/sync-versions.js`
  - Do: Create the standalone crate (`[workspace]` stanza) producing `owlette-swoop.exe`. Copy
    `[profile.release]` **and its comment** from `agent/host/Cargo.toml:40-58`, `.cargo/config.toml` verbatim
    (`+crt-static`), and `build.rs` with its names changed to `owlette-swoop` — Bearfoos quarantine, not
    preference. Keep `[package] version` the FIRST `^version = "X.Y.Z"` match (`sync-versions.js:34` rewrites
    only the first), set `rust-version` to spike 0.2's MSRV, and add the crate to `CARGO_TOMLS` in
    `scripts/sync-versions.js`. **Only this task edits Cargo.toml/Cargo.lock**: pre-declare
    every crate later waves need — the G1 transport crate plus any `[patch]` it requires,
    `serde`/`serde_json`, `thiserror`, `anyhow`, `base64`, `hex`, `hmac`, `sha2`, `hkdf`, `ed25519-dalek`,
    `zeroize`, `rand`, `crossbeam-channel`, `log`, `libloading` (vendor DLLs load by absolute path) and
    `windows` with the features capture/encode/input need, declared under
    `[target.'cfg(windows)'.dependencies]` so the crate still resolves on a non-Windows host — each pinned
    exactly with a reason and exit condition per CLAUDE.md, heavy later-wave crates behind optional features
    `encode-nvenc`, `encode-ffmpeg`, `encode-vpl`, `encode-amf`, `encode-mf`, `encode-openh264`, `turn`,
    `audio-opus`, plus a **non-default** `testhooks` feature (it gates Task 8.7's bundle `overrides` test
    hook), so no parallel task edits the manifest. Set `[features] default = ["encode-nvenc"]` — NVENC is the
    first-class path and loads `nvEncodeAPI64.dll` by absolute path at runtime, so a non-NVIDIA box simply
    fails `probe()`; Task 10.1 finalises the rest of `default` and never adds `testhooks` to it. Create every
    directory and stub plan.md names: `capture/` (including the `capture/testpattern.rs` stub Task 8.7 fills),
    `encode/{nvenc,soft,qsv,amf,mf}/`, `gpu/`,
    `transport/{framing.rs,rtc.rs,pacer.rs,governor.rs,ice_policy.rs,budget.rs,turn/}`, `signal/`, `input/`,
    `cursor/`, `clipboard/`, `audio/`, `displays/`, `securedesk/`, `viewers/`,
    `session/{mod.rs,features.rs,quality.rs,tiers.rs}`, `platform/`, `bundle.rs`, `ipc.rs`, `probe.rs`,
    `log.rs`, plus core types `gpu::Device`, `gpu::Frame`, `encode::EncodedFrame` and `capture::Source`,
    `encode::Encoder`, `transport::VideoSink`, `input::Injector`, `session::Feature` with no-op stubs in
    `session::features::registry()`, and — in `encode/mod.rs` — `encode::BackendCaps` (codecs, max
    width/height per codec, BGRA-texture acceptance, measured max fps, concurrent-session budget) and
    `encode::EncoderConfig`, because Tasks 3.7, 7.1, 7.2 and 7.3 all sign against them. `main.rs` dispatches
    `run`, `probe`, `version`, gates every Windows-only module declaration behind `#[cfg(windows)]` from the
    start so the crate stays checkable on other hosts, calls
    `SetDefaultDllDirectories(LOAD_LIBRARY_SEARCH_SYSTEM32)` + `SetDllDirectory("")` first, and installs a
    size-capped rotating writer into `logs/swoop`, cap in a comment (`cleanup_old_logs` never walks
    subdirectories). Do not read `testdata/` (Task 2.10) or touch `check-security-alerts.mjs` /
    `dependabot.yml` (Task 3.5).
  - Done when: with the working directory `agent/swoop` (never `--manifest-path`), `cargo clippy -- -D warnings` and `cargo test` both pass, and `cargo build --release --locked` produces `target/release/owlette-swoop.exe`; `owlette-swoop.exe version` prints the version from `agent/VERSION` and `probe` emits JSON; `Cargo.lock` is committed; `node scripts/sync-versions.js` lists the swoop crate at the product version; every pin carries a reason and an exit condition; a unit test asserts `session::features::registry()` returns one stub per named feature.
  - Depends on: 0.2 (G1 memo: transport crate + MSRV floor)

- [x] **Task 1.3: web foundations** `[agent]`
  - Files: `web/lib/capabilities.ts`, `web/lib/rateLimit.server.ts`, `web/lib/versionUtils.ts`, `web/lib/authorizedHandler.server.ts`, `web/__tests__/lib/capabilities.test.ts`, `web/__tests__/lib/rateLimit.server.test.ts`, `web/__tests__/lib/authorizedHandler.test.ts`, `web/__tests__/lib/swoopMinVersion.test.ts`
  - Do: Add `MACHINE_REMOTE_CONTROL` and `MACHINE_REMOTE_VIEW` to the `Capability` object
    (`capabilities.ts:1`) with a comment each explaining the split (control = KVM, view = continuous screen +
    audio, which is why it is not `MACHINE_VIEW`). Put both in `SITE_SCOPED_CAPABILITIES` (`:144`);
    `MACHINE_REMOTE_VIEW` goes on `SITE_MEMBER_CAPABILITIES` (`:112`) so admins and owners inherit it — the
    site's `membersMayWatch` gate is enforced later in `web/lib/swoop/policy.server.ts`, never here —
    and `MACHINE_REMOTE_CONTROL` on `SITE_ADMIN_CAPABILITIES` (`:116`) only. Both `USER_LIMITS` and
    `SYSTEM_LIMITS` in `rateLimit.server.ts:40,71` are exhaustive `Record<Capability,…>`, so add entries or
    `tsc` fails: control 10/min user + 50/min system, view 20/min + 100/min (an unlisted capability fails
    OPEN at `:446-450`, which is the whole reason for this line). In `versionUtils.ts`, export
    `SWOOP_MIN_AGENT_VERSION` beside `SITE_TIME_MIN_AGENT_VERSION` (`:158`), copy-only advisory — the real
    gate is `capabilities.swoop == 1` — with a comment naming the release that must confirm the value. In
    `authorizedHandler.server.ts`, add a `BYPASS_EXEMPT_CAPABILITIES` set holding both new capabilities and
    make step 7 (`:609-633`) still run `hasCapability` for them when `config.capability_enforcement` is
    false, keeping the existing `denyAudit` + `problemForbidden` shape and still recording
    `enforcement_bypassed` in the allow-audit metadata for everything else.
  - Done when: `cd web && npx tsc --noEmit` is clean; `npx eslint web/lib/capabilities.ts web/lib/rateLimit.server.ts web/lib/versionUtils.ts web/lib/authorizedHandler.server.ts` reports nothing new; `cd web && npm test -- capabilities rateLimit.server authorizedHandler swoopMinVersion` passes, including new cases proving a site `member` holds `MACHINE_REMOTE_VIEW` but not `MACHINE_REMOTE_CONTROL`, that both have user and system limits, and that with `capability_enforcement: false` a caller lacking `MACHINE_REMOTE_CONTROL` still gets 403 with a `capability_missing` deny row while an unrelated capability is still waved through.
  - Depends on: none

- [x] **Task 1.4: env manifest + CSP + protected path** `[agent]`
  - Files: `scripts/env-manifest.json`, `web/proxy.ts`, `web/__tests__/infra/envManifest.test.ts`, `web/__tests__/middleware.test.ts`
  - Do: Register the eight env keys from plan.md's names registry in `scripts/env-manifest.json` under `vars`,
    alphabetically, each with `targets: ["railway-dev","railway-prod","vercel-prod"]`:
    `SWOOP_JWT_PRIVATE_KEY` and `SWOOP_SESSION_MASTER_KEY` as **`must-match`** (a mismatch across the
    railway-prod/vercel-prod mirror silently breaks JWT verification and per-viewer key derivation after a
    failover), `SWOOP_SIGNAL_RING_SECRET` also `must-match` for the same reason, `CLOUDFLARE_TURN_KEY_API_TOKEN`
    as `secret`, and `SWOOP_JWT_PUBLIC_KEY`, `SWOOP_JWT_KID`, `SWOOP_SIGNAL_URL`, `CLOUDFLARE_TURN_KEY_ID` as
    `config`. Do not use `targets: []` to silence the drift report — `sync-env.mjs check` is expected to list
    these as missing until the owner provisions the values, and that is the signal. In `web/proxy.ts` add
    `'/swoop'` to `PROTECTED_PATHS` (`:19`) so the page needs an authenticated, MFA-satisfied session, and
    extend `connect-src` in `buildContentSecurityPolicy` (`:73`) with the origin derived from
    `process.env.SWOOP_SIGNAL_URL` — emit both the `https://` and `wss://` forms of that origin, and omit it
    entirely when the variable is unset so dev and preview keep working. The browser must receive the
    signaling URL from the session-create API response, never from a `NEXT_PUBLIC_` variable, so add no public
    key. Do not touch `scripts/check-security-alerts.mjs` or `.github/dependabot.yml` (Task 3.5). Note in a
    comment that CSP does not constrain `RTCPeerConnection` — this buys the signaling socket only.
  - Done when: `node -e "JSON.parse(require('fs').readFileSync('scripts/env-manifest.json','utf8'))"` succeeds; `cd web && npm test -- envManifest middleware` passes, with new cases asserting the eight keys exist with exactly those classes and targets, that the three sensitive ones are `must-match`, that `/swoop/site/machine` redirects an unauthenticated request to `/login`, and that the CSP contains the `wss://` signaling origin when `SWOOP_SIGNAL_URL` is set and no swoop origin at all when it is unset; `npx eslint web/proxy.ts` is clean; `npx tsc --noEmit` is clean.
  - Depends on: none

- [x] **Task 1.5: agent paths and directories** `[agent]`
  - Files: `agent/src/shared_utils.py`, `agent/tests/unit/test_swoop_paths.py`
  - Do: Add the swoop path surface every Wave-2 agent module imports, beside the cortex block at
    `shared_utils.py:1064-1068`: `SWOOP_EXE_NAME = 'owlette-swoop.exe'`, `SWOOP_LOG_DIR =
    get_data_path('logs/swoop')`, `SWOOP_IPC_DIR = get_data_path('ipc/swoop')`, `get_swoop_dir()` returning
    `<install_root>\swoop`, and `get_swoop_exe_path()` returning the exe path or `None` when it is absent —
    resolve the install root exactly the way `get_desktop_exe_path()` does (`:878-884`) so a relocated install
    still works. Add `get_data_path('logs/swoop')` and `get_data_path('ipc/swoop')` to the list in
    `ensure_data_directories()` (`:797-816`). These five names are the interface Tasks 2.1, 2.2 and 2.3 import;
    do not rename them. Leave `cleanup_old_logs` (`:1097`) alone — it is deliberately non-recursive and the
    streamer rotates `logs/swoop` itself (Task 1.2); add a one-line comment beside `SWOOP_LOG_DIR` saying so, so
    nobody "fixes" it later. No other module is edited in this task.
  - Done when: `agent/.venv/Scripts/python -m pytest agent/tests/unit/test_swoop_paths.py -q` passes with cases for: every constant resolving under a monkeypatched `PROGRAMDATA`; `ensure_data_directories()` creating both new directories and staying idempotent; `get_swoop_exe_path()` returning `None` when the exe is absent and the full path when a fixture file exists; and `cleanup_old_logs` still skipping subdirectories (pinning why swoop self-rotates). The full suite `agent/.venv/Scripts/python -m pytest agent/tests/ -q` stays green.
  - Depends on: none

---

## Wave 2: agent integration, server libraries, CI

- [ ] **Task 2.1: spawn helper + SwoopManager** `[agent]`
  - Files: `agent/src/swoop_spawn.py`, `agent/src/swoop_manager.py`, `agent/tests/unit/test_swoop_spawn.py`, `agent/tests/unit/test_swoop_manager.py`
  - Do: `swoop_spawn.py` owns the launch. Duplicate the service's SYSTEM token and retarget `TokenSessionId` to
    the console session exactly as `owlette_service.py:2777-2827` does — never `runas`, never `ShellExecute`,
    no UAC path. `_launch_command_as_user` (`:2829`) cannot be reused: `bInheritHandles=0`. Create inheritable
    anonymous pipes for stdin and stdout plus a stderr file handle in `shared_utils.SWOOP_LOG_DIR`, set
    `STARTF_USESTDHANDLES` and `lpDesktop="WinSta0\\Default"`, and restrict inheritance to those three handles
    via `STARTUPINFO.lpAttributeList = {'handle_list': [...]}`; if pywin32 lacks it, mark only those
    three inheritable and log that. Launch `CREATE_SUSPENDED`, assign to a Job Object
    (`JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`), resume. **Refuse to spawn** when `shared_utils.get_swoop_dir()` lacks
    the protected DACL Task 2.6 applies (SYSTEM:F, Administrators:F, Users:RX, inheritance disabled), checked as
    `display_manager.py:315-372` does — log, never repair; and when `owlette-swoop.exe version` differs from
    `shared_utils.APP_VERSION`. Fetch the bundle from `POST {get_api_base_url()}/agent/swoop/bundle` (pattern:
    `firebase_client.py:2531-2546`), write it as one stdin line, zero the buffer — bundle, token and keys are
    never logged. `swoop_manager.py` runs its own threads and exposes `ensure_streamer(sid)`,
    `kill(reason)`, `on_session_change()`, `status()`; a reader thread parses stdout events (`ready`,
    `viewer_joined`, `viewer_left`, `sas_request`, `status`, `exiting`) onto a bounded queue; `kill` writes
    `{"type":"kill"}`, waits, closes the job; crashes back off exponentially with a cap, refusing after N
    spawns in M minutes; session start/end and refusals go through `firebase_client.log_event`. Every method
    returns immediately — nothing may run on the 5-second loop. Task 3.1 assigns it as
    `service.swoop_manager`; do not edit `owlette_service.py`.
  - Done when: `agent/.venv/Scripts/python -m pytest agent/tests/unit/test_swoop_spawn.py agent/tests/unit/test_swoop_manager.py -q` passes with cases for: a DACL mismatch refusing the spawn; a version mismatch refusing the spawn; the bundle string never appearing in captured log records; `kill()` writing the kill line before terminating the job; crash backoff growing and capping; the spawn-rate ceiling refusing and logging; every stdout event type parsed; and every manager method returning without blocking. `agent/.venv/Scripts/python -m pytest agent/tests/ -q` stays green and `python -m py_compile agent/src/swoop_spawn.py agent/src/swoop_manager.py` passes.
  - Depends on: 1.1, 1.5

- [ ] **Task 2.2: capability heartbeat + fast command types** `[agent]`
  - Files: `agent/src/firebase_client.py`, `agent/src/swoop_capability.py`, `agent/tests/unit/test_swoop_capability.py`, `agent/tests/unit/test_firebase_client_heartbeat.py`
  - Do: In the heartbeat write at `firebase_client.py:1527-1538`, add three **dotted** keys beside the existing
    `'capabilities.displayRemoteApply': 1` — `'capabilities.swoop'`, `'osFamily'`, `'arch'`. Dotted keys only:
    a whole-map `capabilities: {...}` write drops the sibling. Add `'swoop_session_requested'`, `'swoop_kill'`
    and `'swoop_refresh'` to `_FAST_COMMAND_TYPES` (`:1570`) with a comment — the slow lane queues behind an
    in-flight install, which would make the kill switch minutes late. Create `swoop_capability.py` holding
    cross-plan rule C3's normalisation tables — `osFamily = {'win32':'windows','darwin':'macos','linux':'linux'}
    [sys.platform]`, `arch = {'AMD64':'x64','x86_64':'x64','arm64':'arm64','aarch64':'arm64'}
    [platform.machine()]` — plus a local `streamer_capable()` (Windows: true) and `swoop_capability_value()`
    returning 1 only when `shared_utils.get_swoop_exe_path()` is not None **and** `streamer_capable()` is true.
    `agent/src/osadapter` does not exist on `dev`; the local `streamer_capable()` is deliberate and
    tri-platform's Wave 4 folds it in later — say so in a comment. Unknown platform or machine values fall back
    without raising, and nothing here does I/O on the heartbeat path beyond the existing exe-path check.
  - Done when: `agent/.venv/Scripts/python -m pytest agent/tests/unit/test_swoop_capability.py agent/tests/unit/test_firebase_client_heartbeat.py -q` passes with: a table test pinning every C3 mapping (`win32→windows`, `darwin→macos`, `linux→linux`; `AMD64→x64`, `x86_64→x64`, `arm64→arm64`, `aarch64→arm64`); a test that a reader treating an **absent** `osFamily` as `windows` is the documented contract; a test that the heartbeat payload contains the three dotted keys and still contains `capabilities.displayRemoteApply`; a test that `capabilities.swoop` is 0 when the exe is absent; and a test that all three swoop types are in `_FAST_COMMAND_TYPES`. Full suite `agent/.venv/Scripts/python -m pytest agent/tests/ -q` stays green.
  - Depends on: 1.5

- [ ] **Task 2.3: doorbell client** `[agent]`
  - Files: `agent/src/swoop_doorbell.py`, `agent/requirements.txt`, `agent/tests/unit/test_swoop_doorbell.py`
  - Do: Build the self-supervised doorbell socket, the documented exception to the ConnectionManager rule
    (plan.md owner ruling; `research/review-3-delivery.md` F1). Interface:
    `SwoopDoorbell(on_ring, get_agent_token, shutdown_event)` with `start()`, `stop()` and `is_connected()`;
    it owns its own thread and its own exponential backoff with full jitter and a cap, and it **must never**
    call `ConnectionManager.register_thread` (`connection_manager.py:698`) or `report_error` (`:436`) — the
    watchdog at `:765-786` treats a dead supervised thread as a Firestore failure, so a Cloudflare outage
    would cycle the Firestore connection on every machine in the fleet. It may read an injected
    connection-state getter to avoid dialling while the machine is offline. Mint the socket token with
    `POST {get_api_base_url()}/agent/swoop/doorbell-token` using the agent token pattern at
    `firebase_client.py:2531-2546` (Task 3.3 ships that route; unit-test against a mock), re-mint on 401 or
    expiry, and never log the token or any part of it. Enable ping interval/timeout, cap the inbound message
    size, and treat a `ring` payload as **a sid and nothing else** — reject any other shape, hand the sid to
    `on_ring` without blocking the socket thread. Add `websocket-client` to `agent/requirements.txt` pinned
    exactly, in the file's existing comment style, with a written reason (synchronous, thread-friendly client;
    the agent has no asyncio loop) and an exit condition (revisit when the agent gains an event loop, or when
    the pin blocks a security fix).
  - Done when: `agent/.venv/Scripts/python -m pytest agent/tests/unit/test_swoop_doorbell.py -q` passes with cases for: reconnect backoff growing and capping across repeated failures; a simulated 10-minute outage producing zero calls into any ConnectionManager method (assert with a strict mock); a well-formed ring invoking `on_ring` with the sid; a ring carrying any extra field being rejected; the token never appearing in captured log records; and `stop()`/`shutdown_event` ending the thread within its timeout. `pip install -r agent/requirements.txt` resolves, and the full suite `agent/.venv/Scripts/python -m pytest agent/tests/ -q` stays green.
  - Depends on: 1.1, 1.5

- [ ] **Task 2.4: web server libraries** `[agent]`
  - Files: `web/lib/swoop/tokens.server.ts`, `web/lib/swoop/keys.server.ts`, `web/lib/swoop/turn.server.ts`, `web/lib/swoop/sessionStore.server.ts`, `web/lib/swoop/policy.server.ts`, `web/lib/swoop/signal.server.ts`, `web/__tests__/lib/swoop/tokens.server.test.ts`, `web/__tests__/lib/swoop/keys.server.test.ts`, `web/__tests__/lib/swoop/turn.server.test.ts`, `web/__tests__/lib/swoop/sessionStore.server.test.ts`, `web/__tests__/lib/swoop/policy.server.test.ts`, `web/__tests__/lib/swoop/signal.server.test.ts`, `web/__tests__/rules/swoopSessions.test.ts`
  - Do: Six server-only libraries; Wave 3 wires the routes. `tokens.server.ts`: EdDSA mint/verify
    with `node:crypto` Ed25519 — header carries `alg: 'EdDSA'` and `kid` from `SWOOP_JWT_KID`; claims per
    `PROTOCOL.md` (`iss=owlette-api`, `aud ∈ {swoop-signal, swoop-host}`, `role ∈ {viewer, host, doorbell}`,
    uid, site, machine, sid, viewer id, `ctl`, mandatory `fp`, `exp ≤ 60 s`, single-use `jti`); never log a
    token or a key. `keys.server.ts`: `K_session = HKDF(SWOOP_SESSION_MASTER_KEY, sid)` — exactly the
    spelling `PROTOCOL.md` and plan.md D8 carry, and the info string is the sid alone because a sid already
    identifies one streamer lifetime on one machine (later viewers attach to the live sid) — and
    `k = HKDF(K_session, viewerId)`, both derived on demand, never persisted, and only a
    viewer's own `k` ever leaves the server. `turn.server.ts`: mint via
    `POST rtc.live.cloudflare.com/v1/turn/keys/{id}/credentials/generate-ice-servers` with
    `customIdentifier = siteId`, TTL ≤ 48 h, plus `revokeTurnCredentials(username)`; comment that
    `customIdentifier` on that endpoint is unverified (spike 6.8) and name the `/credentials/generate`
    fallback. `sessionStore.server.ts`: admin-SDK reads/writes of
    `sites/{s}/machines/{m}/swoop_sessions/{sid}` — `state`, `endReason`, viewers, lease and absolute expiry,
    timestamps, and **no key material, tokens or TURN credentials**; never a command document (Task
    2.11 owns that). `policy.server.ts`: enablement from `sites/{s}/settings/swoop` (`enabled`,
    `excludedMachineIds`, `membersMayWatch`, `indicator`), a member refused when `membersMayWatch` is false, an
    excluded machine refused, `ctx.auth.keyContext !== null` refused with `api_key_not_permitted`, a 10-minute
    server-side step-up window keyed to the session that **only a live `verifyMfaProof` /
    `verifyPasskeyStepUpAssertion` ceremony** may open (never `session.mfaCompletedAt`, never a device-trust
    cookie — `web/lib/sessionManager.server.ts:219-221`), zero-factor accounts refused, and 5-minute lease
    rules with a 12 h cap that re-check membership, enablement and capability. `signal.server.ts`: the
    server's only client for the Worker's control routes — `ringDoorbell({siteId, machineId, sid})` →
    `POST {SWOOP_SIGNAL_URL}/v1/ring` and `killSession({siteId, machineId, sid})` → `POST /v1/kill`, both
    authenticating with `SWOOP_SIGNAL_RING_SECRET`, both sending **a sid and nothing else**, both with a short
    timeout and a typed failure that the caller treats as "fall back to the polled command", never as a 500.
    Never log the secret. `firestore.rules` untouched.
  - Done when: `cd web && npx tsc --noEmit` is clean, `npx eslint web/lib/swoop/*.ts` reports nothing new, and `npm test -- swoop` passes with cases for: a minted viewer token round-tripping and a tampered one failing; a token missing `fp` refused at mint; `exp` capped at 60 s; two viewers deriving different `k` from one `K_session` and neither recovering `K_session`; TURN mint sending `customIdentifier` and revoke hitting the documented path; a session document write rejected in test if it contains any key-shaped field; an api-key caller refused with `api_key_not_permitted`; a step-up window that cannot be opened from a timestamp; and a member refused when `membersMayWatch` is false. `cd web && npm run test:rules` passes including the new spec proving member, site admin, owner and agent contexts are all denied read and write on `swoop_sessions`.
  - Depends on: 1.1, 1.3, 1.4

- [ ] **Task 2.5: rust-build.yml** `[agent]`
  - Files: `.github/workflows/rust-build.yml`
  - Do: There is no Rust CI today. Create one workflow templated on `.github/workflows/agent-tests.yml`:
    `permissions: contents: read` only, a `concurrency` group keyed on the ref with
    `cancel-in-progress: true`, `timeout-minutes` per job, and `push`/`pull_request` path filters covering
    `agent/host/**`, `agent/swoop/**`, `desktop/src-tauri/**` and the workflow file itself. Every action is
    pinned to a full commit SHA with a `# vN` comment — reuse
    `actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v6` with `persist-credentials: false`, and pin
    the toolchain and cache actions the same way. Runner is `windows-latest` for all three crates (the swoop
    and host crates are Windows-only). One step per crate using **`working-directory:`** — `agent/host`,
    `agent/swoop`, `desktop/src-tauri` — never `--manifest-path`, which drops the crate's `.cargo/config.toml`
    and with it `+crt-static` (the VCRUNTIME140 fleet failure 3.2.3 shipped to fix). Each crate runs
    `cargo clippy --all-targets -- -D warnings` then `cargo test --locked`. Add a Rust cache step
    (`Swatinem/rust-cache`, SHA-pinned) so the job fits its timeout. The Tauri crate may need its frontend
    built first — if `cargo clippy` fails without it, add the `npm ci && npm run build` step in `desktop/`
    before it rather than weakening the lint. Leave `cargo deny` and lockfile registration to Task 3.5, and do
    not edit `build-installer.yml` (Task 2.6).
  - Done when: the workflow file parses as YAML; running each job's commands locally passes — with the working directory `agent/swoop`, `cargo clippy -- -D warnings` and `cargo test`; likewise in `agent/host` and `desktop/src-tauri`; every `uses:` is a 40-character SHA with a version comment; `permissions`, `concurrency`, `timeout-minutes` and path filters are all present; `pipx run zizmor .github/workflows/rust-build.yml` (if available) reports nothing above informational; and the first push touching a Rust path shows the run green.
  - Depends on: 1.2

- [ ] **Task 2.6: build + installer** `[agent+human]`
  - Files: `agent/build_installer_full.bat`, `agent/build_installer_quick.bat`, `agent/owlette_installer.iss`, `.github/workflows/build-installer.yml`
  - Do: Read `.claude/skills/build-system.md` first. In `build_installer_full.bat`, extend the `[7/9]` Rust
    step (`:262-304`) to build `agent\swoop` too — `pushd`, `cargo build --release`, `popd`, plus the host's
    "cargo reported success but the exe is missing" guard — keeping the step count at nine so no `[n/9]` label
    drifts, and in step 8 copy `owlette-swoop.exe` into `build\installer_package\swoop\`, failing loudly on a
    copy error. Mirror the re-copy in `build_installer_quick.bat`, failing loudly when the package has no swoop
    exe. In `owlette_installer.iss` make **only the three approved
    edits**: (1) `Source: "build\installer_package\swoop\*"; DestDir: "{app}\swoop"; Flags: ignoreversion`;
    (2) `owlette-swoop` added to the name+path kill pass (`:1140-1200`), mirroring the desktop block
    (`:1176-1183`) — by name scoped with `$_.Path -like '*\Owlette\*'`, never by PID, after the service-host
    kill and before the python pass; (3) a protected DACL via `icacls "{app}\swoop" /inheritance:r` granting
    **well-known SIDs** (`*S-1-5-18` Full, `*S-1-5-32-544` Full, `*S-1-5-32-545` read/execute, `(OI)(CI)`) so
    localized group names cannot break it; Inno's `Permissions:` cannot disable inheritance, so `[Dirs]` is
    not enough. It runs on every install and upgrade, covering the upgrade path. Uninstall cleanup
    is Task 7.7 — not here. In `build-installer.yml`, raise `timeout-minutes`
    (`:73`) for a third crate on a cold cache, add a SHA-pinned Rust cache step, and scan the new exe
    (`MpCmdRun.exe -Scan -ScanType 3 -File <copy> -DisableRemediation`) after the build and **before** the
    base64-subjects step (`:154`).
  - Done when: `build_installer_full.bat` (run non-interactively with stdin from NUL per the build skill) produces both `owlette-swoop.exe` in the package and `Owlette-Installer-vX.Y.Z.exe`; `build_installer_quick.bat` re-packages without rebuilding; `iscc` compiles the .iss with no warnings; on a clean install `icacls "C:\ProgramData\Owlette\swoop"` shows SYSTEM:F, Administrators:F, Users:RX and no inherited ACEs; the Defender scan step reports no detection; and a **human upgrade test from the oldest fielded version** (not from dev) leaves a running service, a swoop directory with the protected DACL, no stranded `owlette-swoop.exe`, and no UAC prompt at any point.
  - Depends on: 1.2

- [ ] **Task 2.7: agent command handlers** `[agent]`
  - Files: `agent/src/swoop_commands.py`, `agent/tests/unit/test_swoop_commands.py`
  - Do: Create the command-router module, shaped exactly like `machine_commands.py:45-53`: a module-level
    `register_handlers(router: CommandRouter) -> None` that calls `router.register("<type>")(handler)` for
    `swoop_session_requested`, `swoop_kill` and `swoop_refresh`, and handlers taking `(cmd_data, cmd_id,
    service)`. The wiring into `owlette_service.py` (`:955-977`) is Task 3.1's — do not edit that file.
    Every payload carries **a sid and nothing else** beyond the command envelope the server stamps
    (`type`, `siteId`, `machineId`, `timestamp`, `status`, `queuedBy` and the lifecycle fields), and the sid
    rule is per type: `swoop_session_requested` must carry a `sid` (plain string) and nothing else;
    `swoop_kill` carries an optional `sid` (absent means "kill whatever is running"); `swoop_refresh` carries
    no `sid`, because site enablement toggles for a machine with no live session. Any other field is refused,
    returning an `Error: …` string so `firebase_client._mark_command_failed` picks it up (same convention as
    `machine_commands`). The handler does nothing but hand off to the manager reached as
    `service.swoop_manager` — `ensure_streamer(sid)` for `swoop_session_requested`, `kill(reason)` for
    `swoop_kill`, `on_session_change()` for `swoop_refresh` — fetching it with `getattr` and returning an
    `Error:` string when it is absent, exactly as `machine_commands` does for `firebase_client`. No network
    I/O, no sleeping, no file reads: these three types are on the fast lane (Task 2.2) and must return in
    milliseconds so nothing lands on the 5-second loop. Never log a bundle, a token or anything but the sid.
  - Done when: `agent/.venv/Scripts/python -m pytest agent/tests/unit/test_swoop_commands.py -q` passes with cases for: all three types registered on a fake router; each handler calling exactly one manager method — `ensure_streamer(sid)`, `kill(reason)` built from the command type and the optional sid, `on_session_change()`; a payload with an extra field refused; a `swoop_session_requested` with no sid refused; a missing `service.swoop_manager` returning an `Error:` string rather than raising; and every handler returning without any network, sleep or filesystem call (assert with strict mocks). The full suite `agent/.venv/Scripts/python -m pytest agent/tests/ -q` stays green.
  - Depends on: 1.1

- [ ] **Task 2.8: signaling Worker** `[agent]`
  - Files: `infra/swoop-signal/package.json`, `infra/swoop-signal/package-lock.json`, `infra/swoop-signal/wrangler.toml`, `infra/swoop-signal/tsconfig.json`, `infra/swoop-signal/src/index.ts`, `infra/swoop-signal/src/room.ts`, `infra/swoop-signal/src/jwt.ts`, `infra/swoop-signal/src/messages.ts`, `infra/swoop-signal/test/**`
  - Do: Create the Cloudflare Worker project (its own dev dependencies are approved; this is **not** part of
    `web/`, so nothing is added to `web/package.json`). `wrangler.toml` declares `env.dev` and `env.prod`, the
    Durable Object binding and migration, and **no secrets** — `SWOOP_JWT_PUBLIC_KEY`, `SWOOP_JWT_KID` and
    `SWOOP_SIGNAL_RING_SECRET` arrive through `wrangler secret put` (Task 3.4 owns the deploy workflow; do not
    create it here). One Durable Object per machine, using the WebSocket **hibernation** API so an idle
    doorbell costs nothing. Verify every socket's EdDSA JWT with WebCrypto Ed25519, selecting the public key by
    `kid` and accepting two keys during a rotation overlap; derive the room name from the token's `site` and
    `machine` claims and **never** from a client-supplied path or query value; enforce `role ∈ {viewer, host,
    doorbell}` per message type per `PROTOCOL.md`, relaying `offer`/`answer`/`candidate` only between the host
    and the viewer they name. `POST /v1/ring` and `POST /v1/kill` authenticate with `SWOOP_SIGNAL_RING_SECRET`
    compared in constant time, take a sid and nothing else, and are the API's only entry points; `GET /health`
    is unauthenticated with a fixed body. Add flood limits — max message size, per-connection message rate, max
    viewers per room, per-machine ring cap per minute — each with its number in a comment. Tests use vitest.
    Never log a token or a key. Do not touch `scripts/check-security-alerts.mjs` or `.github/dependabot.yml`
    (Task 3.5).
  - Done when: `cd infra/swoop-signal && npm ci && npx vitest run` passes with cases for: a valid host, viewer and doorbell token accepted and an unknown `kid` refused; a token for machine B unable to reach machine A's room even when the URL names A; a ring without the shared secret refused; a ring with an extra field refused; flood limits closing a socket that exceeds them; `/health` answering 200 without auth; and every signaling message type round-tripping against Task 1.1's golden vectors. `npx wrangler deploy --dry-run --outdir dist -e dev` and `-e prod` both succeed; `package-lock.json` is committed; `npx tsc --noEmit` is clean.
  - Depends on: 1.1, 1.4

- [ ] **Task 2.9: web protocol library** `[agent]`
  - Files: `web/lib/swoop/protocol.ts`, `web/__tests__/lib/swoop/protocol.test.ts`
  - Do: Implement the browser half of `agent/swoop/PROTOCOL.md` as one dependency-free module: TypeScript
    types plus encode/decode functions for the signaling messages, the binary frame header (`DataView`, exact
    field order/width/endianness from the spec), the input, cursor, clipboard, control and feedback messages,
    and the JWT claim shape the page validates before use. Add no npm package — `web/` gets none. This is a
    pure library: no Firestore access (that lives in `web/hooks/`), no React, no `fetch`, no logging of token
    or key material. Decoders are total functions returning a typed result or a typed rejection carrying the
    reason code the vector manifest names — never a thrown string, because the receive path in Wave 3 runs per
    frame. Drive the tests from `agent/swoop/testdata/protocol/index.json`: read the manifest, iterate every
    entry, round-trip each `expect: "accept"` vector (decode → encode → byte-identical) and assert every
    `expect: "reject"` vector is rejected with the manifest's reason — including the viewer JWT with no `fp`,
    the JWT expired against the time anchor, the JWT for another machine, the frame chunk with a dangling
    reference, and the version mismatch. Task 2.10 implements the same manifest in Rust; do not edit anything
    under `agent/swoop/`.
  - Done when: `cd web && npm test -- swoop/protocol` passes with every vector in `index.json` exercised (the test fails if the manifest gains an entry the spec does not cover); `npx eslint web/lib/swoop/protocol.ts web/__tests__/lib/swoop/protocol.test.ts` reports nothing new; `npx tsc --noEmit` is clean; and the module imports nothing outside `web/lib/swoop/`.
  - Depends on: 1.1

- [ ] **Task 2.10: Rust protocol core** `[agent]`
  - Files: `agent/swoop/src/bundle.rs`, `agent/swoop/src/ipc.rs`, `agent/swoop/src/transport/framing.rs`, `agent/swoop/src/signal/messages.rs`, `agent/swoop/tests/protocol_vectors.rs`
  - Do: Fill the four stubs Task 1.2 created, against `agent/swoop/PROTOCOL.md`. `bundle.rs`: parse and
    validate the stdin bundle line — reject unknown or missing fields, hold the JWT public key(s) and `kid`,
    the time anchor (verify `exp` against the anchor plus monotonic elapsed, never `SystemTime::now()`: these
    are drifting kiosks), parse the optional test-only `overrides` object **only** under
    `#[cfg(feature = "testhooks")]` — without that feature `overrides` is an unknown field and the bundle is
    invalid (exit 10) — and wrap every secret in `zeroize` so it is wiped on drop; the bundle is never
    logged, never written to disk, never echoed in an error message. `ipc.rs`: the stdin/stdout line protocol
    — inbound `{"type":"kill"}` and `{"type":"sas_result",…}`, outbound `ready`, `viewer_joined`,
    `viewer_left`, `sas_request`, `status`, `exiting` — plus the exit-code constants 0/10/11/12/13/14/20 as a
    single typed enum the rest of the crate uses. `transport/framing.rs`: the binary frame header encode/decode
    and the fragmentation rule for the G1 winner, including the invariant that a chunk with a dangling
    reference is never produced. `signal/messages.rs`: serde types for the ten signaling messages with strict
    field handling (`deny_unknown_fields`). Add no dependency — everything needed is already declared in
    `Cargo.toml`; if something genuinely is missing, stop and log it for Task 1.2 rather than editing the
    manifest. The integration test walks `testdata/protocol/index.json` exactly as Task 2.9's does, so both
    ends are proven against one oracle.
  - Done when: with the working directory `agent/swoop` (never `--manifest-path`), `cargo clippy -- -D warnings` and `cargo test` both pass; `tests/protocol_vectors.rs` iterates every entry in `index.json`, round-trips each accept vector byte-identically and rejects each reject vector with the manifest's reason code; a test asserts an expired-against-anchor token is refused while the same token passes with a later anchor; a test asserts no bundle field appears in any `Display`/`Debug` output of the error types; and `Cargo.toml` and `Cargo.lock` are unchanged by this task.
  - Depends on: 1.1, 1.2

- [ ] **Task 2.11: sid-only command action module** `[agent]`
  - Files: `web/lib/actions/requestSwoopSession.server.ts`, `web/__tests__/lib/actions/requestSwoopSession.server.test.ts`
  - Do: Write the only code in the product that may enqueue a swoop command. Signature mirrors
    `executeMachineCommand.server.ts` without reusing it: `requestSwoopSession({ type, sid, siteId, machineId,
    actor, auditActor, correlationId })` where `type ∈ {swoop_session_requested, swoop_kill, swoop_refresh}`
    and `sid` is optional in the signature, required per type: mandatory for `swoop_session_requested`,
    optional for `swoop_kill` (absent means "kill whatever is running"), and never sent for `swoop_refresh`,
    which fires on a site enablement toggle where no session exists.
    It writes `sites/{s}/machines/{m}/commands/pending` with the command id as the map key, using
    `stampCommand` and `emitMutation` the way `executeMachineCommand.server.ts:193-231` does, and the document
    holds **only** `{ type }`, plus `sid` when the type carries one, plus the canonical envelope (`siteId`,
    `machineId`, `timestamp`, `status`, `queuedBy`) and `stampCommand`'s lifecycle fields. Nothing else — no bundle, no JWT, no key, no TURN
    credential, no viewer id: every site member can read that collection (`firestore.rules:303-306`), which is
    why the plan makes the command a notification and the agent fetches the bundle over its own authenticated
    channel. Keep the swoop types **out** of `ALLOWED_COMMAND_TYPES` (`executeMachineCommand.server.ts:25`) —
    do not modify that file — so the generic commands route cannot reach them. Mirror the offline 409 for
    `swoop_session_requested`; let `swoop_kill` write even when the machine is offline, so a machine that comes
    back kills a stale streamer, and say why in a comment. Import nothing from `web/lib/swoop/` — session
    creation, tokens and keys belong to Task 2.4, and Wave 3's route composes the two.
  - Done when: `cd web && npm test -- requestSwoopSession` passes with cases asserting: the written document's key set is exactly the envelope plus `type`, plus `sid` for the types that carry one and **no** `sid` key at all for `swoop_refresh` (a deep key comparison per type, so a future field addition fails the test); each of the three types writing successfully; a non-swoop type rejected; the offline 409 for session-request and the write-anyway behaviour for kill; every `swoop_*` type absent from `ALLOWED_COMMAND_TYPES`; and the generic commands action rejecting a swoop type with `unsupported_command_type`. `npx eslint web/lib/actions/requestSwoopSession.server.ts` reports nothing new and `npx tsc --noEmit` is clean.
  - Depends on: 1.1

- [ ] **Task 2.12: browser matrix spike** `[agent+human]`
  - Files: `agent/swoop/spikes/browser-matrix/**`, `dev/active/swoop/spikes/2.12-browser-matrix.md`
  - Do: Build a static harness (HTML + a small TS/JS module + canned encoded chunks; **no `Cargo.toml`
    anywhere under `spikes/`**, which would break the crate build) that a human runs on each target browser and
    OS, and record the results in the memo. Measure, per browser × OS: WebCodecs `VideoDecoder.isConfigSupported`
    for HEVC Main 8-bit and H.264 **and** a real decode of a canned chunk (support claims and real decode
    disagree); whether Edge needs the paid HEVC Video Extension and what failure looks like without it; the
    macOS static-desktop decoder stall and whether the host floor-frame-rate workaround clears it;
    a multi-window soak at 2/4/6/8 simultaneous decoding windows to find the hardware-decoder ceiling;
    `RTCCertificate.getFingerprints()` availability and, where it is missing, that parsing `a=fingerprint:`
    out of the local offer works — the whole `fp` binding depends on one of the two existing at mint time;
    Playwright's bundled Chromium codec set, which decides whether Wave 8's e2e can feed H.264 chunks or must
    use VP8/AV1 or a stubbed decoder; and the prompt behaviour of keyboard lock, pointer lock with
    `unadjustedMovement`, and clipboard read/write. The memo ends with a per-browser support matrix and a
    numbered list of the decisions Wave 3.11, 3.12 and 4.6 inherit, each stated as a rule those tasks can
    follow without re-reading the raw results.
  - Done when: the harness runs from a plain static file server with no build step; the memo `dev/active/swoop/spikes/2.12-browser-matrix.md` records measured results (not predictions) for Chrome, Edge, Firefox and Safari on Windows and macOS, names the Playwright codec decision explicitly, and states the `fp` acquisition method for every browser tested; any browser that could not be tested is listed as untested rather than assumed; and, with the working directory `agent/swoop`, `cargo clippy -- -D warnings` and `cargo test` still pass (proving the spike directory did not disturb the crate).
  - Depends on: 1.1

## Wave 3: picture-path modules and APIs

- [ ] **Task 3.1: Agent wiring** `[agent]`
  - Files: `agent/src/owlette_service.py`, `agent/tests/integration/__init__.py`, `agent/tests/integration/fake_streamer.py`, `agent/tests/integration/test_swoop_wiring.py`
  - Do: Register the swoop command handlers in the `__init__` block at `owlette_service.py:955-979`, copying the shape of the roost/machine/process registrations exactly — `from swoop_commands import register_handlers as _register_swoop_handlers` inside a `try/except` that logs a warning and continues. Construct `SwoopManager` and `SwoopDoorbell` in `main()` right after `self.firebase_client.start()` (`:7802-7806`), on a daemon thread, never on the tick; the doorbell takes `on_ring=manager.ensure_streamer`, `get_agent_token=self.firebase_client.auth_manager.get_valid_token` and a `threading.Event` shutdown flag. Per the owner's ruling it must never call `connection_manager.register_thread` (`:698`) or `report_error` (`:436`). For session changes, read `win32ts.WTSGetActiveConsoleSessionId()` on the loop beside `self._process_cortex_ipc_commands()` (`:8001`), compare with the last-seen id and call `manager.on_session_change()` only on a change — imitate the single-flight off-loop pattern at `:2254-2286`. In `SvcStop` (`:1931-1956`) call `manager.kill('service_stop')` and set the doorbell's shutdown event beside `terminate_cortex()`. Also add the three swoop types to the per-type command-throttle exemption at `:4570-4580` — the `if cmd_type not in ('mcp_tool_call', 'ack_display_topology')` guard at `:4573`, with `COMMAND_RATE_LIMIT_SECONDS = 5` at `:4553` — keeping the existing comment style: the rate key is the command type plus a process id, which for swoop collapses to `swoop_session_requested:` / `swoop_kill:` / `swoop_refresh:`, so a second viewer's session request, a revocation kill following an operator kill, or a second enablement toggle inside five seconds returns `Error: rate limited …` and is recorded as a **failed** command. This is the only task that edits this guard. No UAC path, nothing blocking on the 5 s loop.
  - Done when: `agent/.venv/Scripts/python -m pytest agent/tests/` is green, including new tests that (a) a ring drives `ensure_streamer` and spawns `fake_streamer.py`, (b) `SvcStop` kills it, (c) `swoop_commands` handlers are reachable through `CommandRouter`, (d) no `register_thread`/`report_error` call reaches `ConnectionManager` (assert with a spy), (e) a signal endpoint unreachable for a simulated 10 minutes leaves `connection_manager.state` CONNECTED, (f) two `swoop_session_requested` commands handled inside 5 s are both dispatched, neither returning `Error: rate limited …`. `agent/.venv/Scripts/python -m py_compile agent/src/owlette_service.py` exits 0.
  - Depends on: 2.1, 2.3, 2.7

- [ ] **Task 3.2: User API routes** `[agent]`
  - Files: `web/app/api/sites/[siteId]/machines/[machineId]/swoop/sessions/route.ts`, `web/app/api/sites/[siteId]/machines/[machineId]/swoop/sessions/[sessionId]/route.ts`, `web/app/api/sites/[siteId]/machines/[machineId]/swoop/sessions/[sessionId]/lease/route.ts`, `web/__tests__/api/swoop/sessions.test.ts`, `web/__tests__/api/swoop/lease.test.ts`
  - Do: Wrap each route in `authorizedSiteHandler` + `withRateLimit`, copying the shape of `…/machines/[machineId]/commands/route.ts:415-440`. POST `sessions` takes `{ control: boolean, fp: string, clientCaps, mfaProof }` and uses `Capability.MACHINE_REMOTE_CONTROL` when `control` is true, else `MACHINE_REMOTE_VIEW`. Order of refusals: `ctx.auth.keyContext !== null` → 403 `api_key_not_permitted` (the `capability_enforcement=false` bypass is closed centrally by Task 1.3's `BYPASS_EXEMPT_CAPABILITIES` in `authorizedHandler.server.ts` — do not re-implement it here); missing/invalid `fp` → 400; no live proof → 401 `step_up_required`; then `parseMfaProof` → `verifyMfaProof` / `verifyPasskeyStepUpAssertion` in-process (`web/lib/mfaProof.server.ts:79,196,264`, precedent `api/mfa/backup-codes/route.ts:51-60`) — never a timestamp; an account with zero enrolled factors is refused, not waved through. Delegate the work to `web/lib/actions/requestSwoopSession.server.ts` and the Wave 2 libs (`tokens`, `keys`, `turn`, `sessionStore`, `policy`, `signal`). After the session document is written, ring the doorbell with `signal.server.ts`'s `ringDoorbell` (sid only) **and** enqueue the sid-only fallback command; neither failure blocks the response. The response carries `{ sid, viewerJwt, k, iceServers, signalUrl, expiresAt }` — never `K_session`, never in a URL. GET returns session state; DELETE ends it with an `endReason`. `lease` renews for 5 minutes, re-checking membership, site enablement and capability, with a 12 h absolute cap.
  - Done when: `cd web && npx jest __tests__/api/swoop/sessions.test.ts __tests__/api/swoop/lease.test.ts` is green with named cases: api-key caller 403 `api_key_not_permitted`; proof-less request 401 `step_up_required`; zero-factor account refused; with `capability_enforcement: false`, a member without `MACHINE_REMOTE_CONTROL` still gets 403 `capability_missing`; missing `fp` 400; non-member 404; lease after membership removal 403; lease past the 12 h cap 403. `npx eslint` clean on all three routes; `npx tsc --noEmit` clean.
  - Depends on: 1.3, 2.4, 2.9, 2.11

- [ ] **Task 3.3: Agent API routes** `[agent]`
  - Files: `web/app/api/agent/swoop/doorbell-token/route.ts`, `web/app/api/agent/swoop/bundle/route.ts`, `web/app/api/agent/swoop/events/route.ts`, `web/__tests__/api/swoop/agent-routes.test.ts`
  - Do: Every route authenticates with `requireMachineAuthAndScope` from `web/app/api/_shared.ts:504-570`, which binds both `site_id` and `machine_id`. Do **not** use `requireAgentOrSiteScope` (`:61-95`) or `requireAgentOrSiteAuthAndScope` (`:709-756`) — they check `site_id` only — and do not copy the `if (decodedToken.site_id && …)` pattern from `app/api/agent/screenshot/route.ts:47`, which skips the check when the claim is absent. `requireMachineAuthAndScope` admits any site member holding a session cookie (`_shared.ts:553-560`: non-key auth skips the scope check), so it is necessary but **not sufficient** on an agent-only route. Each of the three routes must additionally establish an agent principal and refuse anything else: call `resolveAgentPrincipal(req, siteId, machineId)` (`web/lib/sitePolicy.server.ts:190-218`) and return 404 on `null` or `'mismatch'`, or re-verify the bearer and refuse `decoded.role !== 'agent'` with 403, the `app/api/agent/screenshot/route.ts:33-35` pattern. A session or API-key caller must never reach the bundle. `doorbell-token` mints a `role=doorbell` EdDSA JWT (`aud=swoop-signal`, `kid`) whose `machine` claim is what the Worker derives its Durable Object name from; it refuses with 403 `swoop_disabled` when `sites/{siteId}/settings/swoop.enabled` is false or this machine is in `excludedMachineIds` (read through `web/lib/swoop/policy.server.ts`), so a machine with swoop off holds no signaling socket — the agent's slow-retry path (spike 0.6) is written against that code. `bundle` takes `{ sid }`, verifies that `sid` was minted for *this* machineId (else 404) and returns the session bundle: host JWT, `K_session`, the current and previous `SWOOP_JWT_PUBLIC_KEY` + `kid`, an authoritative `now` time anchor taken from the API's own clock, ICE/TURN config, signal URL, the site's `indicator` policy beside its enablement, and the expected streamer version. `events` records host-side lifecycle and denial events (rejected JWT, `fp` mismatch, view-only viewer sending input) into `sites/{siteId}/audit_log`. Never log a token, key or bundle — not at debug.
  - Done when: `cd web && npx jest __tests__/api/swoop/agent-routes.test.ts` is green with named cases: machine A's token requesting machine B's bundle → 404; a `sid` minted for another machine → 404; a session-cookie (non-agent) caller → 404/403; a doorbell-token request for a site with swoop disabled → 403 `swoop_disabled`; a host denial event writes an `audit_log` row with `outcome: 'deny'`. A test greps the three route sources and asserts neither `requireAgentOrSiteScope` nor `requireAgentOrSiteAuthAndScope` appears. `npx eslint` clean on all three routes.
  - Depends on: 1.3, 2.4

- [ ] **Task 3.4: Worker deploy pipeline** `[agent+human]`
  - Files: `.github/workflows/swoop-signal-deploy.yml`, `infra/swoop-signal/README.md`
  - Do: Write the deploy workflow using `.github/workflows/agent-tests.yml` as the template — actions pinned to SHAs with a trailing `# vN` comment, `permissions: contents: read`, a `concurrency` group, `timeout-minutes`, `persist-credentials: false`, and path filters on `infra/swoop-signal/**` plus the workflow itself. Push to `dev` deploys `wrangler deploy --env dev`; push to `main` deploys `--env prod`; both run the Worker's vitest suite first and then smoke-check `GET /health` on the deployed URL, failing the job on a non-200. Repo secrets are `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID`; Worker secrets (`SWOOP_JWT_PUBLIC_KEY`, `SWOOP_JWT_KID`, `SWOOP_SIGNAL_RING_SECRET`) are set with `wrangler secret put` and never committed. The README documents both environments, every secret and where it comes from, the rollback procedure (`wrangler deployments list` → `wrangler rollback`), and the key-rotation overlap window in which the Worker verifies against two public keys. The `[human]` half: create the scoped Cloudflare API token (Workers Scripts Edit + Durable Objects), add the two repo secrets, and run the first `--env dev` deploy by hand.
  - Done when: `zizmor .github/workflows/swoop-signal-deploy.yml` reports no findings; a push to `dev` touching `infra/swoop-signal/**` runs the workflow green and `curl https://<dev worker>/health` returns 200; the README's rollback steps have been executed once on dev and the result noted in the file.
  - Depends on: 2.8

- [ ] **Task 3.5: Security-gate + dependabot lockfile registration** `[agent]`
  - Files: `scripts/check-security-alerts.mjs`, `.github/dependabot.yml`
  - Do: An advisory against a lockfile this script does not know about resolves as UNRESOLVED, and per `.claude/skills/build-system.md` an UNRESOLVED alert is blocking — so a new lockfile that is not registered blocks every installer release. In `ECOSYSTEM_MANIFESTS` (`scripts/check-security-alerts.mjs:277-284`) add `'agent/swoop/Cargo.lock'` to **both** the `rust` and the `cargo` arrays, and add `'infra/swoop-signal/package-lock.json'` to the `npm` array. In `.github/dependabot.yml` add `/agent/swoop` to the cargo ecosystem's `directories` (`:65-71`) and `/infra/swoop-signal` to the npm ecosystem's `directories` (`:29-33`) — do not create a second npm block. Keep the surrounding comment style: each block carries a sentence saying what the directory is. Do not change any other manifest entry, and do not add an ack.
  - Done when: `node scripts/check-security-alerts.mjs` exits 0 with both new lockfiles present in the checkout; `node -e "const s=require('fs').readFileSync('scripts/check-security-alerts.mjs','utf8'); if(!/agent\/swoop\/Cargo\.lock/.test(s)) process.exit(1)"` exits 0; `npx js-yaml .github/dependabot.yml` (or any YAML parse) succeeds and the cargo block lists three directories.
  - Depends on: 1.2, 2.8

- [ ] **Task 3.6: Capture (Desktop Duplication)** `[agent]`
  - Files: `agent/swoop/src/capture/` (fill the stub files the Task 1.2 scaffold created; do not add or rename modules — if a stub you need is missing, stop and log it)
  - Do: Implement the `capture::Source` trait over DXGI Desktop Duplication, yielding `gpu::Frame` values. Prefer `IDXGIOutput5::DuplicateOutput1` with an explicit format list and fall back to `IDXGIOutput1::DuplicateOutput` (always `DXGI_FORMAT_B8G8R8A8_UNORM`). Call `SetMaximumFrameLatency(1)`. Run a paced acquisition group anchored on the frame timestamp: `AcquireNextFrame` with a 0 ms timeout inside the group and 200 ms to re-anchor after a miss, and `ReleaseFrame` as early as possible — holding a frame starves the encoder through Desktop Duplication's global critical section. Treat `DXGI_ERROR_WAIT_TIMEOUT` as "nothing changed" (not an error) and expose it so the session can hold a floor frame rate; on `DXGI_ERROR_ACCESS_LOST` rebuild the D3D11 device and the duplication object. Process all `GetFrameMoveRects` before all `GetFrameDirtyRects`. One duplication per `IDXGIOutput`; enumerate outputs with their `DesktopCoordinates` (which may be negative) and expose rotation un-applied, as DDA returns it. Capture runs on its own dedicated thread that loops `OpenInputDesktop`/`SetThreadDesktop` and rebuilds on a desktop switch; an `OpenInputDesktop` failure is not proof the machine is locked. The capture device must be on the same adapter as the output.
  - Done when: `cargo clippy -- -D warnings` and `cargo test` both pass with the working directory `agent/swoop` (never `--manifest-path`). Pure unit tests cover virtual-desktop rect math with a negative origin, rotation mapping and move-before-dirty ordering. GPU tests are `#[ignore]`d with a doc comment giving the dev-box command `cargo test -- --ignored capture` and the expected result (a frame from each of the two attached monitors).
  - Depends on: 1.2, 2.10

- [ ] **Task 3.7: NVENC encoder** `[agent]`
  - Files: `agent/swoop/src/encode/nvenc/` (fill the scaffold's stub files only)
  - Do: Implement the `encode::Encoder` trait over the NVENC SDK behind the crate's existing `encode-nvenc` cargo feature, producing `encode::EncodedFrame`. Use the configuration two independent projects converged on (plan D5/D7, spike memo 0.9): preset `P1`, `NV_ENC_TUNING_INFO_ULTRA_LOW_LATENCY`, `enablePTD = 1`, `gopLength = idrPeriod = NVENC_INFINITE_GOPLENGTH`, `frameIntervalP = 1` (no B-frames), `NV_ENC_PARAMS_RC_CBR` with `averageBitRate == maxBitRate`, `zeroReorderDelay = 1`, `enableLookahead = 0`, `lowDelayKeyFrameScale = 1`, `multiPass = NV_ENC_TWO_PASS_QUARTER_RESOLUTION`, `vbvBufferSize = bitrate/fps` with `vbvInitialDelay` equal and a 1/60 s floor, `repeatSPSPPS = 1`, single slice, DPB 4 with `numRefL0 = NV_ENC_NUM_REF_FRAMES_1`. Mandatory H.264 fix: `h264VUIParameters.bitstreamRestrictionFlag = 1` with `max_num_reorder_frames = 0` and `max_dec_frame_buffering = 0` — without it Chrome's decoder holds a full DPB (208 ms → 8.3 ms measured). Feed the BGRA DDA texture straight in (NVENC converts on chip). Expose a force-IDR entry point for the Wave 5 cooldown policy. Refuse resolutions above the codec's cap (H.264 4096×4096, HEVC 8192×8192) with a typed error, and map a session-mutex failure (`0x887A0001`) to exit code 13. Expose at the `encode::nvenc` module root, with exactly these names, `pub fn probe() -> BackendCaps` and `pub fn create(cfg: &EncoderConfig) -> Result<Box<dyn Encoder>>`, `#[cfg(feature = "encode-nvenc")]`-gated — the same two symbols Tasks 7.1/7.2 expose and Task 7.3 calls, against the types Task 1.2 defines in `encode/mod.rs`.
  - Done when: `cargo clippy -- -D warnings` and `cargo test` pass from `agent/swoop`. A pure-Rust SPS parser unit test runs over the golden vectors in `agent/swoop/testdata/` and asserts `bitstream_restriction_flag == 1` and `max_num_reorder_frames == 0`. A GPU test that encodes 120 frames and re-parses the emitted SPS is `#[ignore]`d with the documented dev-box command `cargo test -- --ignored nvenc` and its expected output recorded in the module doc comment.
  - Depends on: 1.2, 2.10

- [ ] **Task 3.8: Transport wiring** `[agent]`
  - Files: `agent/swoop/src/transport/rtc.rs`, `agent/swoop/src/transport/pacer.rs` (never edit `transport/framing.rs`, which Wave 2 owns)
  - Do: Drive str0m's sans-IO `Rtc` from a UDP socket plus a timer (poll output → transmit / re-arm / handle event), gather and trickle ICE candidates, complete DTLS, and expose the local DTLS certificate fingerprint so Task 3.9 can MAC it. Default (G1 path A) is one ordered data channel for video with `maxPacketLifeTime` set to 2–3 frame intervals (33–50 ms at 60 fps) — not `maxRetransmits: 0`, which at 1% loss delivers ~18% of a 200 KB access unit. Implement `transport::VideoSink` over the fragments `framing.rs` produces (~1200 B, matching str0m's `max_payload_size`). str0m's `Channel::write` returns `Ok(false)` when the frame exceeds `sctp.available()` — the 128 KiB `MAX_BUFFERED_ACROSS_STREAMS` ceiling shared with every other channel — so count every refusal, surface it as a governor signal, and never drop a frame silently. Keep a send-side high watermark with keyframes exempt. `pacer.rs` spreads a frame's fragments across the frame interval instead of bursting them, and accounts bytes actually written per viewer. If G1 chose path B or C instead, `rtc.rs` writes an RTP media track through str0m's `Writer::write` (str0m packetizes, RFC 7798 for H.265) and the pacer becomes a thin wrapper over str0m's `LeakyBucketPacer` and GoogCC estimate — the `VideoSink` seam and both filenames stay the same.
  - Done when: `cargo clippy -- -D warnings` and `cargo test` pass from `agent/swoop`. Unit tests cover fragment pacing spread, the write-refusal counter, and the keyframe watermark exemption against a fake channel. A loopback test against a local peer is `#[ignore]`d with the dev-box command and expected result documented (`Ok(false)` count zero over 60 s at the configured bitrate).
  - Depends on: 1.2, 2.10, G1

- [ ] **Task 3.9: Signaling client + admission** `[agent]`
  - Files: `agent/swoop/src/signal/` (every stub except `messages.rs`, which Wave 2 owns)
  - Do: Connect over WSS to `GET /v1/room/{siteId}/{machineId}` with the host JWT from the bundle, speak the `hello` / `ring` / `viewer-join` / `host-ready` / `offer` / `answer` / `candidate` / `kill` / `bye` / `error` messages from `messages.rs`, and exit 14 when the room is unreachable after the configured retries. Verify every viewer JWT in-process against the public key selected by the token's `kid` from the bundle (the bundle carries two during a rotation; an unknown `kid` is a refusal, logged, not a fallback). Check `exp` against the bundle's authoritative time anchor plus monotonic elapsed time — never `SystemTime::now()`, because these are drifting kiosk clocks. `fp` is mandatory: a token without it is rejected, and a token whose `fp` does not equal the viewer offer's `a=fingerprint:` is rejected. Derive `k = HKDF(K_session, viewerId)` and send a MAC over the host's own DTLS fingerprint and `sid` in `host-ready`. A `kill` frame exits the process cleanly (code 0). Enforce admission limits: maximum concurrent viewers, a minimum inter-join interval, and refusal after N joins in M minutes — every refusal emitted as a host event so it reaches `audit_log`.
  - Done when: `cargo clippy -- -D warnings` and `cargo test` pass from `agent/swoop`. Unit tests run the golden vectors in `agent/swoop/testdata/`, including the negative vectors: a token with no `fp` is rejected, a token whose `fp` mismatches the offer is rejected, an expired token measured against the anchor is rejected, an unknown `kid` is rejected, and a clock 6 hours off does not change any of those outcomes.
  - Depends on: 1.1, 1.2, 2.10

- [ ] **Task 3.10: Web signaling + peer** `[agent]`
  - Files: `web/lib/swoop/signaling.ts`, `web/lib/swoop/peer.ts`, `web/__tests__/lib/swoop/signaling.test.ts`, `web/__tests__/lib/swoop/peer.test.ts`
  - Do: `peer.ts` generates an `RTCCertificate` **first** and reads its fingerprint via `getFingerprints()`, falling back to parsing `a=fingerprint:` out of its own `createOffer()` SDP, so the caller can put `fp` in the session-create request body before any peer traffic. Then build `new RTCPeerConnection({ certificates: [cert], iceServers, iceCandidatePoolSize: 1, bundlePolicy: 'max-bundle', rtcpMuxPolicy: 'require' })`. The browser always offers and the host answers; re-negotiation is always a fresh browser offer. Before `setRemoteDescription`, verify the host's `host-ready` MAC over (host fingerprint ‖ sid) using WebCrypto HMAC with the per-viewer key `k` returned by the session-create route — a mismatch aborts the connection and reports an error, it never proceeds. `signaling.ts` owns the WSS to the Worker (viewer JWT), trickles candidates both ways, and reconnects with bounded backoff. If `getStats()` still shows a `relay` selected pair at T+3 s, call `restartIce()` exactly once. Never put the viewer JWT or `k` in a URL. If G1 chose path B or C, `peer.ts` additionally adds a recvonly video transceiver and sets the playout-delay hint `min=0, max ∈ (0,500] ms` (never `max=0`); nothing else in either file changes.
  - Done when: `cd web && npx jest __tests__/lib/swoop` is green with named cases: the fingerprint is available before any offer is created; a wrong MAC aborts and `setRemoteDescription` is never called; the correct MAC proceeds; one and only one `restartIce()` fires for a persistent relay pair. `npx eslint web/lib/swoop/signaling.ts web/lib/swoop/peer.ts` clean.
  - Depends on: 2.9, G1

- [ ] **Task 3.11: Web receive + decode** `[agent]`
  - Files: `web/lib/swoop/video/receiver.ts`, `web/lib/swoop/video/decoder.ts`, `web/__tests__/lib/swoop/receiver.test.ts`, `web/__tests__/lib/swoop/decoder.test.ts`
  - Do: `receiver.ts` reassembles access units from the fragment header defined in `agent/swoop/PROTOCOL.md` (Task 1.1) and validated by the golden vectors in `agent/swoop/testdata/`. On a `frameId` gap it drops to the next recovery point and asks for an IDR — it never reorders and never submits a chunk whose references it did not receive (Chrome hard-fails a damaged H.265 picture). `decoder.ts` configures `VideoDecoder` for Annex-B (no `description`), `optimizeForLatency: true`, `hardwareAcceleration: 'prefer-hardware'`, and submits `EncodedVideoChunk`s with microsecond timestamps. A resolution or SPS change is always a new `configure()` plus a key chunk — Chromium rejects a non-IRAP H.265 config change outright. Apply `decodeQueueSize` backpressure before every `decode()`, track a submit→output EWMA and raise a diagnostic above 1.5 frame intervals, and hand each `VideoFrame` to the presenter callback, which owns `close()`. A decoder error triggers reconfigure plus an IDR request, never a silent stall. If G1 chose path B, `receiver.ts` becomes a thin adapter over the `<video>` element's own buffering and `decoder.ts` is unused; under C it receives frames from an `RTCRtpScriptTransform` instead of a data channel — the exported interface stays identical.
  - Done when: `cd web && npx jest __tests__/lib/swoop/receiver.test.ts __tests__/lib/swoop/decoder.test.ts` is green against a stubbed `VideoDecoder` global, with named cases: golden-vector reassembly byte-exact; a dropped fragment yields no chunk and one IDR request; a dangling-reference chunk is never submitted; a resolution change reconfigures before the next chunk; `decode()` is not called while `decodeQueueSize` is over the limit. `npx eslint` clean on both files.
  - Depends on: 1.1, 2.9, G1

- [ ] **Task 3.12: Web presentation + client capability probe** `[agent]`
  - Files: `web/lib/swoop/video/presenter.ts`, `web/lib/swoop/clientCaps.ts`, `web/__tests__/lib/swoop/presenter.test.ts`, `web/__tests__/lib/swoop/clientCaps.test.ts`
  - Do: `presenter.ts` implements plan D17. Present from the decoder's output callback, never from `requestAnimationFrame` (rAF costs up to 16.7 ms and does not fire in a hidden tab). Use a `desynchronized: true` 2D canvas, feature-detected with `ctx.getContextAttributes().desynchronized`, falling back to `ImageBitmapRenderingContext` + `transferFromImageBitmap`. Call `frame.close()` immediately after upload. Use `requestVideoFrameCallback` only to measure (`presentedFrames` for drop/duplicate counting, `expectedDisplayTime` for display phase) — never to schedule. No dejitter buffer: present on decode and drop to the freshest frame. Document in a comment that a `desynchronized` canvas reads back empty through `drawImage`, so the latency harness must sample the renderer instead. `clientCaps.ts` probes `VideoDecoder.isConfigSupported()` for each candidate codec string (`hev1.1.6.L93.B0`, `avc1.640033`, …) with `hardwareAcceleration: 'prefer-hardware'`, wrapped in try/catch because Chromium has thrown instead of resolving `{supported:false}`, cross-checks `navigator.mediaCapabilities.decodingInfo`, and returns the ladder H.264-floor → HEVC-where-hardware-says-yes. Note in comments that Edge falls back to H.264 (paid HEVC extension) and Firefox is the structurally degraded client — expected, not bugs.
  - Done when: `cd web && npx jest __tests__/lib/swoop/presenter.test.ts __tests__/lib/swoop/clientCaps.test.ts` is green with named cases: presentation happens on the decoder callback and no rAF is scheduled; the ImageBitmap fallback is used when `desynchronized` is unsupported; every frame is closed exactly once; a throwing `isConfigSupported` yields "unsupported" and not a rejection; the ladder degrades to H.264 when HEVC probes false. `npx eslint` clean on both files.
  - Depends on: 2.9

## Wave 4: first picture (gate G2)

- [ ] **Task 4.1: Host thin session** `[agent]`
  - Files: `agent/swoop/src/session/mod.rs`, `agent/swoop/src/main.rs`
  - Do: Implement the `run` verb end to end for exactly one viewer: read one bundle line from stdin (never a file, never a command line), validate it, then capture (3.6) → encode (3.7) → `transport::VideoSink` (3.8) with signaling from 3.9. As the process's first action call `SetDefaultDllDirectories(LOAD_LIBRARY_SEARCH_SYSTEM32)` and `SetDllDirectory("")`, and load every vendor DLL by absolute path. Emit newline-delimited JSON events on stdout — `ready`, `viewer_joined`, `viewer_left`, `status`, `exiting` — and accept `{"type":"kill"}` on stdin for a clean exit. Use the fixed exit codes: 0 normal, 10 bundle invalid, 11 version mismatch (the bundle's expected version differs from this binary's), 12 no capture source, 13 no encoder, 14 signaling unreachable, 20 internal. Write stderr to a size-capped rotating log under `logs/swoop/` (name the cap in the code), and write a minidump there on an unhandled panic — this process will crash on somebody's iGPU and nothing else collects diagnostics. Keep `version` working. Never log the bundle, a token or a key, not even partially. No UAC path anywhere.
  - Done when: `cargo clippy -- -D warnings` and `cargo test` pass from `agent/swoop`. Unit tests cover bundle parsing (valid, malformed → 10, version mismatch → 11) and the stdout event encoding against the golden vectors from Task 1.1. An end-to-end run on the dev box is `#[ignore]`d with the documented command and expected result; `owlette-swoop.exe run` fed a hand-built bundle prints `ready` and then `viewer_joined`.
  - Depends on: 3.6, 3.7, 3.8, 3.9

- [ ] **Task 4.2: Stage page + UI slots** `[agent]`
  - Files: `web/app/swoop/[siteId]/[machineId]/page.tsx`, `web/app/swoop/[siteId]/[machineId]/layout.tsx`, `web/hooks/useSwoopSession.ts`, `web/components/Footer.tsx`, `web/components/swoop/{SwoopStage,SwoopToolbar,SwoopStatsOverlay,SwoopStepUpDialog,SwoopQualityMenu,SwoopDisplayPicker,SwoopSpecialKeys,SwoopAudioToggle,SwoopPresence}.tsx`, `web/lib/swoop/{clipboard,audio,displays,presence,lease,stepUp,features}.ts`
  - Do: Create every slot later waves fill, so no Wave 6+ task ever edits the page or the hook. The layout is full-window with no global chrome; add `/swoop` to the early-return list in `components/Footer.tsx:46` beside `/admin`, `/` and `/hoot` (the root layout renders the Footer, so a nested layout cannot remove it). `useSwoopSession.ts` POSTs the session-create route (3.2), builds the peer (3.10), receiver/decoder (3.11) and presenter (3.12), and returns `{ state, error, stats, canvasRef, stepUp }`. It calls `attach(session)` on every module exported by the `web/lib/swoop/features.ts` registry — each lib stub exports `export function attach(_session: SwoopSession) {}` and returns a no-op detach. Every component stub renders `null` today. Mount `<SwoopStepUpDialog open={stepUp.required} enrolled={stepUp.enrolled} onProof={stepUp.submitProof} onCancel={stepUp.cancel} />` in the page now; that prop contract is frozen, and `onProof` takes the body `parseMfaProof` accepts (`web/lib/mfaProof.server.ts:79`) and forwards it verbatim. All copy lowercase, lucide icons only, theme tokens only, no new npm packages, Firestore only through hooks.
  - Done when: `cd web && npx tsc --noEmit` and `npx eslint app/swoop hooks/useSwoopSession.ts components/swoop lib/swoop components/Footer.tsx` are both clean. `npm test` stays green. Navigating to `/swoop/<site>/<machine>` in `npm run dev` renders a full-window stage with no footer and no page scrollbar, and the browser console shows the session-create request being made.
  - Depends on: 3.2, 3.10, 3.11, 3.12

- [ ] **Task 4.3: Input injection** `[agent]`
  - Files: `agent/swoop/src/input/` (fill the scaffold's stub files only)
  - Do: Implement the `input::Injector` trait with `SendInput`. Absolute mouse moves use `MOUSEEVENTF_ABSOLUTE | MOUSEEVENTF_VIRTUALDESK | MOUSEEVENTF_MOVE` normalised to 0..65535 against `SM_XVIRTUALSCREEN` / `SM_YVIRTUALSCREEN` / `SM_CXVIRTUALSCREEN` / `SM_CYVIRTUALSCREEN` — never the primary monitor, and correct for negative origins when a monitor sits left of or above the primary. Support a relative mode (`MOUSEEVENTF_MOVE` alone) for pointer lock, relaying raw deltas. Keys go as `KEYEVENTF_SCANCODE` with `wVk = 0`, taking scancodes from `agent/swoop/testdata/keymap.json`, and set `KEYEVENTF_EXTENDEDKEY` for right Ctrl/Alt, the arrows, Insert/Delete/Home/End/PageUp/PageDown, numpad Enter, numpad `/` and PrintScreen. Wheel uses `MOUSEEVENTF_WHEEL`/`HWHEEL` with signed `mouseData` in `WHEEL_DELTA` units. Make the process per-monitor DPI aware so the injection coordinate equals the capture coordinate. Track every pressed scancode and button per viewer and synthesise releases on disconnect, timeout, viewer switch and desktop switch — stuck keys are the top user-visible bug, and `SendInput` does not reset keyboard state. Rate-limit injected events per viewer. Batch a frame's coalesced moves into one `SendInput` call. Note in a comment that a UIPI-blocked `SendInput` returns 0 with no useful `GetLastError`.
  - Done when: `cargo clippy -- -D warnings` and `cargo test` pass from `agent/swoop`. Pure unit tests cover the 0..65535 normalisation over a negative-origin, mixed-DPI, two-monitor layout (a case invisible on a single-monitor box), the extended-key table against `testdata/keymap.json`, wheel sign, and that a simulated disconnect emits exactly one key-up per held key. Live injection tests are `#[ignore]`d with the documented dev-box command.
  - Depends on: 1.1, 1.2

- [ ] **Task 4.4: Cursor** `[agent]`
  - Files: `agent/swoop/src/cursor/` (fill the scaffold's stub files only)
  - Do: Track the pointer from Desktop Duplication's frame metadata: position and visibility come from `DXGI_OUTDUPL_FRAME_INFO.PointerPosition`, and the shape from `GetFramePointerShape`, which only needs re-reading when the shape actually changes (`LastMouseUpdateTime == 0` means no pointer update this frame). Decode all three shape encodings (monochrome, colour, masked colour) into a single RGBA image plus a hotspot, and convert the hotspot from host pixels through the same virtual-desktop and per-monitor-DPI transform Task 4.3 uses for injection — a wrong hotspot is the classic "the I-beam selects from its corner" bug. Emit shape updates and a position stream as the message types defined in `signal/messages.rs` and `agent/swoop/PROTOCOL.md` (do not edit either). When the adapter draws the pointer in hardware the desktop image does not contain it, so the viewer must composite — say so in the emitted metadata. Downscale shapes above 32×32 CSS pixels, because browsers silently ignore large CSS cursors and Safari accepts only a handful of sizes.
  - Done when: `cargo clippy -- -D warnings` and `cargo test` pass from `agent/swoop`. Unit tests decode one fixture of each of the three shape encodings to expected RGBA bytes, assert hotspot translation on a negative-origin mixed-DPI layout, and assert that an unchanged shape produces no shape message. A live capture test is `#[ignore]`d with the documented dev-box command.
  - Depends on: 1.1, 1.2, 3.6

- [ ] **Task 4.5: GPU convert/scale** `[agent]`
  - Files: `agent/swoop/src/gpu/convert.rs`, `agent/swoop/src/gpu/scale.rs` (never touch `gpu/mod.rs`, which owns `Device` and `Frame`)
  - Do: Provide BGRA→NV12 conversion and downscale entirely on the GPU — a captured frame must never round-trip through system memory. Implement conversion as a compute shader over the D3D11 device from `gpu::Device`, with `ID3D11VideoProcessor`/`VideoProcessorBlt` as the documented alternative, and state the colour matrix and range you emit (BT.709) in the module doc so the encoder and the browser agree. NVENC takes BGRA directly and converts on chip, so the fast path must be a no-op passthrough — the conversion exists for the Intel/AMD and software backends that arrive in Wave 7, where it is mandatory rather than optional. `scale.rs` downscales before encode and implements the giant-canvas policy: refuse or tile above a backend's axis cap (AMF is capped at 4096 on each axis; NVENC allows 4096×4096 for H.264 and 8192×8192 for HEVC), and pick a downscale factor that brings a Mosaic-sized canvas under the cap while keeping the aspect ratio. Never change display configuration to make a canvas fit.
  - Done when: `cargo clippy -- -D warnings` and `cargo test` pass from `agent/swoop`. Pure unit tests cover the cap/tiling decision table (1080p, 4K, 8K-wide Mosaic, a 4096-capped backend) and the aspect-preserving scale factor. GPU tests that run the shader over a known BGRA pattern and check the NV12 output against expected luma/chroma are `#[ignore]`d with the documented dev-box command and expected values.
  - Depends on: 1.2

- [ ] **Task 4.6: Web input capture + keymap** `[agent]`
  - Files: `web/lib/swoop/input.ts`, `web/lib/swoop/keymap.ts`, `web/__tests__/lib/swoop/keymap.test.ts`, `web/__tests__/lib/swoop/input.test.ts`
  - Do: `keymap.ts` maps `KeyboardEvent.code` (the physical key — never `.key`, which is layout- and IME-dependent) to the scancodes in `agent/swoop/testdata/keymap.json`, including the extended-key flag. It offers a Cmd mapping option for macOS clients: `MetaLeft`/`MetaRight` → Ctrl for editing shortcuts, or → Win, selectable. `input.ts` attaches keyboard, pointer and wheel listeners to the stage element, `preventDefault`s everything except a small allow-list, uses `getCoalescedEvents()` and accumulates `movementX/movementY` into one delta per tick rather than one message per raw event, and supports pointer-lock relative mode alongside absolute mode. On `blur`, `visibilitychange` and pointer-lock exit it emits a release for every key it believes is held. Intercept the Escape the browser swallows on pointer-lock release and forward a synthetic one. Document the two input modes — scancode by default, a Unicode/text path when an IME composition is active — and leave the text mode a named, unimplemented seam for Wave 6 rather than a half-built path.
  - Done when: `cd web && npx jest __tests__/lib/swoop/keymap.test.ts __tests__/lib/swoop/input.test.ts` is green, with the keymap test driven directly from `agent/swoop/testdata/keymap.json` (every entry round-trips, and the extended-key set matches exactly), plus cases: coalesced moves collapse to one message; blur releases every held key exactly once; Cmd→Ctrl and Cmd→Win both map as configured. `npx eslint web/lib/swoop/input.ts web/lib/swoop/keymap.ts` clean.
  - Depends on: 1.1

- [ ] **Task 4.7: Governor + feedback** `[agent]`
  - Files: `agent/swoop/src/transport/governor.rs`, `web/lib/swoop/feedback.ts`, `web/__tests__/lib/swoop/feedback.test.ts`
  - Do: Implement the one-way-delay-rise governor moonlight-web ships, since path A has no GoogCC of its own. Every frame carries the host's send time; the client measures how much later a frame arrives than the best of the session, against a 30-second rolling reference, so the two clocks' offset cancels in the subtraction and no clock sync is needed. `feedback.ts` sends a report twice a second over the control channel carrying that delay rise, any `frameId` gaps, arrival/decode/present times and an app-level RTT measured by an explicit ping/pong — do not repeat Parsec's web client, which hardcodes `networkLatency = 0`. It also estimates and reports the QPC↔`performance.now()` offset with an NTP-style exchange, so every per-stage number in the stats overlay is real. `governor.rs` cuts the encoder's target bitrate 20% the moment delay rises (or on a frame gap, or on one of its own send-buffer refusals), holds for 2 seconds, then climbs 5% per quiet report, never above the configured setting. If G1 chose path B or C, the governor becomes an arbiter over str0m's GoogCC estimate rather than the primary controller; `feedback.ts` is unchanged either way.
  - Done when: `cargo clippy -- -D warnings` and `cargo test` pass from `agent/swoop`, with unit tests driving a synthetic report sequence and asserting exactly −20% on a rise, no further cut inside the 2 s hold, +5% per quiet report, and a hard ceiling at the configured rate. `cd web && npx jest __tests__/lib/swoop/feedback.test.ts` is green (report cadence 2 Hz, offset estimation converges on a synthetic clock skew, RTT is measured and non-zero). `npx eslint web/lib/swoop/feedback.ts` clean.
  - Depends on: 2.9, 3.8

**Gate G2** — after this wave: a frame captured on this dev box reaches the browser canvas through the real owlette API and the deployed (or `wrangler dev`) signaling service. Record the result and the first-frame timing in `dev/active/swoop/spikes/` before Wave 5 starts.

## Wave 5: first interactive session → internal pilot (gate G3)

- [ ] **Task 5.1: Host session v2** `[agent]`
  - Files: `agent/swoop/src/session/mod.rs`, `agent/swoop/src/session/features.rs`, `agent/swoop/src/main.rs`
  - Do: Grow Task 4.1's thin session into the real one without regressing it. Wire input injection (4.3) behind the `ctl` claim from the verified viewer JWT — the host is the enforcement point, and a view-only viewer sending input is refused and reported as a host event, never trusted from anything the viewer says. Wire the cursor stream (4.4) and the governor (4.7) so client feedback moves the encoder's target rate. Implement the loss-recovery policy: IDR with a 250–500 ms coalesced cooldown and exponential backoff, sticky "awaiting IDR" state so a burst of requests produces one keyframe, for every encoder — reference invalidation stays out of v1. Hold a floor frame rate on a static desktop (Desktop Duplication reports `DXGI_ERROR_WAIT_TIMEOUT` and hardware decoders stall without it). Keep the process alive for the documented linger after the last viewer leaves, then exit 0 — but stop capture immediately at the last departure so no capture runs behind a cleared indicator. When the bundle carries the test-only `overrides` object — which only a `testhooks` build parses at all (Task 2.10) — select the named test source and encoder and emit a `status` stdout event naming the override, so an overridden session is visible in `logs/swoop` and through the host events route. Register each capability as a `session::Feature` in `features.rs` so Wave 6 adds clipboard, audio and displays without editing `mod.rs`.
  - Done when: `cargo clippy -- -D warnings` and `cargo test` pass from `agent/swoop`. Unit tests cover: a viewer without `ctl` has every input event dropped and one denial event emitted; ten IDR requests inside the cooldown produce one keyframe; the floor frame rate emits on a timeout-only capture loop; linger expiry exits 0 and capture stops at the last `viewer_left`, not at exit. The live interactive run is `#[ignore]`d with its dev-box command documented.
  - Depends on: 4.1, 4.3, 4.4, 4.7

- [ ] **Task 5.2: swoop page v2** `[agent]`
  - Files: `web/app/swoop/[siteId]/[machineId]/page.tsx`, `web/hooks/useSwoopSession.ts`, `web/components/swoop/SwoopStage.tsx`, `web/components/swoop/SwoopToolbar.tsx`, `web/components/swoop/SwoopStatsOverlay.tsx`, `web/lib/swoop/features.ts`
  - Do: Fill the slots Task 4.2 created. `SwoopStage` renders the canvas the presenter draws into and attaches the input capture from `web/lib/swoop/input.ts` (4.6) — do not re-implement it. Take fullscreen, `navigator.keyboard.lock()` and pointer lock on **one** user gesture, because JS-initiated fullscreen is a precondition of keyboard lock and all three need the same activation; when keyboard lock is unavailable (Firefox, Safari) say so in the toolbar rather than failing silently, and note that Escape held for two seconds always exits. `SwoopToolbar` carries the connection state and the lock/fullscreen controls. `SwoopStatsOverlay` shows the per-stage latency breakdown (capture, encode, send, arrive, decode, present) plus app-level RTT from `feedback.ts`. Register the input feature in `web/lib/swoop/features.ts` so the hook attaches it. Keep the step-up dialog's frozen props from 4.2 — `open` / `enrolled` / `onProof` / `onCancel`, where `onProof` receives the body `parseMfaProof` accepts and the hook forwards it verbatim into the session-create POST. All copy lowercase, lucide icons only, theme tokens only, accessible names on every control.
  - Done when: `cd web && npx tsc --noEmit`, `npx eslint app/swoop hooks/useSwoopSession.ts components/swoop lib/swoop/features.ts` and `npm test` are all clean. Manually on the dev box: one click enters fullscreen with keyboard and pointer lock together and the overlay renders. The end-to-end check — typing and mouse movement reach the machine, six non-zero stage timings, a non-zero RTT — belongs to gate G3, because it also needs Task 5.1.
  - Depends on: 4.2, 4.6, 4.7

- [ ] **Task 5.3: Dashboard entry** `[agent]`
  - Files: `web/components/MachineContextMenu.tsx`, `web/hooks/useFirestore.ts`, `web/app/dashboard/page.tsx`, `web/app/dashboard/components/MachineCardView.tsx`, `web/app/dashboard/components/MachineListView.tsx`
  - Do: Add `capabilities?: { swoop?: number; displayRemoteApply?: number }` to the `Machine` interface (`useFirestore.ts:251`) and map it from the machine snapshot. Thread an `onSwoop?: (machineId: string) => void` prop and a `swoopCapable: boolean` flag through the same chain `onLiveView` already uses (`MachineCardView.tsx:65-66,99-100,1100-1101`, `MachineListView.tsx:256-257,674-675`, dashboard handlers at `:1091-1098` and `:1145-1151`). In `MachineContextMenu.tsx` the online block at `:311-331` shows **swoop** instead of live view when `capabilities.swoop === 1`, and the existing live-view item otherwise — exactly one of the two renders, so no machine ever has neither, and "screenshot" is untouched. The label is "swoop into this machine" (lowercase), with a lucide icon and the theme colour tokens the neighbouring items use. Opening calls `window.open('/swoop/<siteId>/<machineId>', '_blank', 'noopener')` — a separate window, never an iframe, and never a token in the URL. Gate only on the capability: site enablement and authorization are enforced server-side by the session-create route, so do not read swoop settings here.
  - Done when: `cd web && npx tsc --noEmit`, `npx eslint components/MachineContextMenu.tsx hooks/useFirestore.ts app/dashboard` and `npm test` are clean. A jest or e2e case asserts that a machine with `capabilities.swoop === 1` shows the swoop item and no live-view item, and a machine without it shows live view and no swoop item. Clicking swoop opens `/swoop/<siteId>/<machineId>` in a new window.
  - Depends on: 4.2

- [ ] **Task 5.4: Site enablement + kill switch** `[agent]`
  - Files: `web/app/api/sites/[siteId]/swoop-settings/route.ts`, `web/lib/actions/setSwoopSettings.server.ts`, `web/hooks/useSwoopSettings.ts`, `web/components/ManageSitesDialog.tsx`, `web/app/api/sites/[siteId]/machines/[machineId]/swoop/kill/route.ts`, `web/__tests__/api/swoop/settings-and-kill.test.ts`
  - Do: Copy the hoot-settings precedent end to end: `app/api/sites/[siteId]/hoot-settings/route.ts` → `lib/actions/setHootRequireTier3Approval.server.ts` → `sites/{siteId}/settings/cortex`, read by `hooks/useHootApprovalSetting.ts`. Here the document is `sites/{siteId}/settings/swoop` holding `{ enabled, excludedMachineIds[], membersMayWatch, indicator }`, GET and PATCH are wrapped in `authorizedSiteHandler` with a site-admin capability, and `useSwoopSettings.ts` subscribes with `onSnapshot` and defaults to the safe state (disabled) when the document or field is missing. Toggling enablement sends a `swoop_refresh` command to the site's online machines through the dedicated Wave 2 action module — never through `ALLOWED_COMMAND_TYPES`, and per Task 2.11's per-type rule that document carries **no** `sid` (there is no session to name on an enablement toggle) and nothing else identifying. The kill route calls `killSession` from `web/lib/swoop/signal.server.ts` (Task 2.4) first — never a hand-rolled fetch — because the Worker path is authoritative and lands in ≤ 2 s while the streamer holds a live socket, and falls back to a `swoop_kill` command (its `sid` optional: absent means "kill whatever is running") for a machine with no live session. Add the settings toggle to `ManageSitesDialog.tsx` in the site's expanded panel, lowercase copy, theme tokens. The `authorizedSiteHandler` wrapper writes the audit row for both routes — do not create or import `web/lib/swoop/audit.server.ts`, which Task 5.6 owns.
  - Done when: `cd web && npx jest __tests__/api/swoop/settings-and-kill.test.ts` is green with named cases: a member cannot PATCH settings; enabling sends `swoop_refresh` only to online machines; an excluded machine is refused a session; the kill route calls `killSession` and only falls back when the Worker reports no session; the enqueued command document's key set is exactly Task 2.11's contract — `type`, `sid` where the type carries one, the envelope (`siteId`, `machineId`, `timestamp`, `status`, `queuedBy`) and `stampCommand`'s lifecycle fields (`createdAt`, `expiresAt`, `auditCorrelationId`) — and carries no bundle, JWT, key, TURN credential or viewer id. `npx eslint` clean on all five source files; `npx tsc --noEmit` clean.
  - Depends on: 2.11, 3.2, 3.4

- [ ] **Task 5.5: Step-up ceremony UI** `[agent]`
  - Files: `web/lib/swoop/stepUp.ts`, `web/components/swoop/SwoopStepUpDialog.tsx`, `web/__tests__/lib/swoop/stepUp.test.ts`
  - Do: Fill the two slots Task 4.2 created; do not touch the page or the hook. The dialog's props are frozen: `{ open: boolean; enrolled: boolean; onProof: (proof) => Promise<void>; onCancel: () => void }`, where `proof` is the body `parseMfaProof` accepts (`web/lib/mfaProof.server.ts:79`) and the caller forwards it verbatim to the session-create route. `stepUp.ts` runs the ceremony: for a passkey, fetch a challenge from `/api/passkeys/step-up/options` and produce an assertion; for TOTP or a backup code, package the entered code. The dialog calls `onProof` with the result and reports the retry's outcome; a 401 `step_up_required` from the session-create route is what opens it, and a successful ceremony is followed by exactly one retry, not a loop. An account with zero enrolled factors cannot control a machine — render an enrol hint pointing at the security settings instead of a code field, since `/api/passkeys/step-up/options` returns `no_passkeys` for such an account. All copy lowercase, lucide icons only, theme tokens only, accessible labels on every input, and never log or store the proof.
  - Done when: `cd web && npx jest __tests__/lib/swoop/stepUp.test.ts` is green with named cases: a passkey ceremony produces a proof and one retry; a TOTP code produces a proof and one retry; a failed proof shows an error and does not retry; a zero-factor account renders the enrol hint and no code field. `npx eslint web/lib/swoop/stepUp.ts web/components/swoop/SwoopStepUpDialog.tsx` clean; `npx tsc --noEmit` clean.
  - Depends on: 3.2, 4.2

- [ ] **Task 5.6: Audit + logs registry** `[agent]`
  - Files: `web/lib/swoop/audit.server.ts`, `web/app/logs/page.tsx`, and the audit call sites inside the Task 3.2 and Task 3.3 route files (this is the only Wave 5 task that edits those routes)
  - Do: `audit.server.ts` wraps `writeAuditEntryBlocking` (`web/lib/auditLog.server.ts:123`) with the swoop event shapes and adds `'swoop_session'` to `AuditTargetKind` (`:48-57`). Security-relevant events go to `sites/{siteId}/audit_log`, not `sites/{siteId}/logs`, because a site admin can bulk-delete site logs and is also the tier that can start a control session. Cover: session start, session end with `endReason`, duration and relayed-or-direct, control grant, a denied request (with `denyReason`), a step-up failure, kill, and the host-side denials that arrive through `/api/agent/swoop/events`. Then call it from the Wave 3 routes — session create (allow and every deny branch), session delete, lease refusal, and the agent events route. Separately, add a `swoop` group to `ACTION_TYPE_GROUPS` in `app/logs/page.tsx:137` for the operational feed; before writing the option list, grep `agent/src/swoop_*.py` for the exact strings passed to `log_event(...)` and list only those — an option nothing emits is a dead filter, which is the documented reason `scheduled_reboot` was removed. Labels are lowercase and match the action they name.
  - Done when: `cd web && npx jest __tests__/lib/swoop __tests__/api/swoop` is green, including a test that every deny branch of the session-create route writes an `audit_log` row with a `denyReason`, and that no swoop security event is written to `sites/{siteId}/logs`. `npx eslint lib/swoop/audit.server.ts app/logs/page.tsx` clean; `npx tsc --noEmit` clean; the logs page renders the new group and filtering by one of its values returns rows.
  - Depends on: 3.2, 3.3

- [ ] **Task 5.7: Capture edge-case spike** `[human]`
  - Files: `dev/active/swoop/spikes/5.7-capture-edge-cases.md`
  - Do: Run Desktop Duplication capture against the hardware and configurations this dev box cannot represent, and write the memo that decides whether a user-token Windows.Graphics.Capture helper is needed in v1 (plan D6 keeps it in reserve). Cover, one section each with the observed result and the exact machine/driver/OS build: TouchDesigner in perform mode (fullscreen, GPU-saturated) — capture works, and what encode latency it costs; Windows 11 24H2 and 25H2, where Lossless Scaling's maintainers report DXGI is no longer reliable without MPO support and Sunshine #3995 records live black screens; a hybrid-GPU laptop, where the capture device must sit on the same adapter as the output; an NVIDIA Mosaic spanned canvas; an HDR display (`DuplicateOutput1` with a float or 10-bit format list); a display powered off; an active RDP session; and a headless machine with no attached output, which must be detected and reported so the UI can recommend a dummy plug. Record failures verbatim, including HRESULTs. End with a single recommendation and its reasoning.
  - Done when: the memo exists with every configuration either measured or explicitly marked "not available, untested", each finding carries the machine, GPU driver and Windows build, and the final section states plainly whether a Windows.Graphics.Capture helper is required for the first release — with the evidence for that call.
  - Depends on: 3.6

**Gate G3** — after this wave: a measured interactive LAN session meets plan.md's latency criteria (60 Hz client p50 ≤ 55 ms and p95 ≤ 80 ms photon-inclusive at 1080p60 on NVENC; ≥ 120 Hz client p50 ≤ 40 ms), with the measurement contract from spike 0.1 applied. On success the unsigned internal pilot runs on the owner's machines only.

## Wave 6: first-release features

- [ ] **Task 6.1: Secure desktop + Ctrl+Alt+Del** `[agent+human]`
  - Files: `agent/swoop/src/securedesk/mod.rs`, `agent/swoop/src/securedesk/watch.rs`, `agent/swoop/src/securedesk/sas.rs`, `agent/src/swoop_manager.py`, `agent/tests/unit/test_swoop_manager_sas.py`, `web/components/swoop/SwoopSpecialKeys.tsx`
  - Do: Fill the `securedesk` Feature — it is already registered as a no-op in `session/features.rs`; do not edit that file. A watcher thread polls `OpenInputDesktop()` at 1–2 Hz and, on a change, signals the capture and input threads to `SetThreadDesktop` onto the new input desktop and re-create the D3D11 device plus the duplication object (reuse the `DXGI_ERROR_ACCESS_LOST` recovery path from Task 3.6). `SetThreadDesktop` fails on a thread that owns windows or hooks, so this stays on the dedicated capture/input threads. An `OpenInputDesktop` failure means "unknown", never "locked" (research `03-windows-host-stack.md` §1.4). Emit a `status` stdout event naming the desktop (`default`/`winlogon`/`screensaver`). Ctrl+Alt+Del: the streamer emits `sas_request`; `swoop_manager.py` calls `SendSAS(FALSE)` from `sas.dll` on its own worker thread — never on the 5-second loop, never elevating — and replies `{"type":"sas_result",…}` on stdin. On a console-session change (`WTSGetActiveConsoleSessionId` moves), SwoopManager kills and respawns the streamer into the new session. `SwoopSpecialKeys.tsx` is a lowercase lucide menu sending ctrl+alt+del, win, alt+tab and esc through the existing input channel.
  - Done when: `cargo clippy -- -D warnings` and `cargo test` pass from `agent/swoop`; a unit test proves a desktop change recreates duplication and that an `OpenInputDesktop` failure is not reported as "locked"; `pytest agent/tests/unit/test_swoop_manager_sas.py` proves `sas_request` → `SendSAS` runs off the main loop, is rate-limited to one SAS per ≥ 2 s, and returns `sas_result`; `npx eslint web/components/swoop/SwoopSpecialKeys.tsx` clean. Human: from a second machine, confirm the logon screen after a reboot with nobody logged in, the lock screen and a UAC consent prompt are visible and controllable, and that ctrl+alt+del from the menu reaches the secure desktop. No UAC prompt is raised by swoop itself.
  - Depends on: 2.1, 4.2, 4.3, 5.1

- [ ] **Task 6.2: Clipboard** `[agent]`
  - Files: `agent/swoop/src/clipboard/mod.rs`, `agent/swoop/src/clipboard/listener.rs`, `agent/swoop/src/clipboard/formats.rs`, `web/lib/swoop/clipboard.ts`, `web/__tests__/lib/swoop/clipboard.test.ts`
  - Do: Fill the `clipboard` Feature (already registered as a no-op; do not edit `session/features.rs`). Host: a listener thread owning a message-only window (`HWND_MESSAGE`) on the **default** desktop with `AddClipboardFormatListener` → `WM_CLIPBOARDUPDATE`. Formats: `CF_UNICODETEXT`, the registered `"PNG"` format, and `CF_DIB`/`CF_DIBV5` for images; `CF_HDROP` is **rejected**, documented in the module doc comment (`PROTOCOL.md` belongs to Task 1.1 — do not edit it). Echo-loop suppression uses both mechanisms: record `GetClipboardSequenceNumber()` after your own `SetClipboardData` and hash the content; drop an update matching either. Caps: text ≤ 256 KiB, image ≤ 2 MiB, chunked and paced so a paste never starves video — str0m caps buffering at 128 KiB across *all* channels (review-1 F1). Only a viewer whose verified JWT carries `ctl` may push to the host. Refuse clipboard sync entirely while the input desktop is `Winlogon` — read it yourself with `OpenInputDesktop` + `GetUserObjectInformationW`, do not depend on Task 6.1. Report transfers above 64 KiB to `/api/agent/swoop/events` for audit. Browser: `clipboard.ts` exports `attach(session)` (called by `features.ts`; do not edit it or the hook) — intercept `copy`/`cut`/`paste`, read the client clipboard on the paste keystroke **before** forwarding it, and apply host→client writes inside the user-activation window.
  - Done when: `cargo clippy -- -D warnings` and `cargo test` pass from `agent/swoop`, covering echo suppression (sequence number and hash), both size caps, `CF_HDROP` rejection and the Winlogon refusal; `npm test` in `web/` covers paste interception ordering (the clipboard read resolves before the key event is forwarded) and the activation-window write; `npx eslint web/lib/swoop/clipboard.ts` clean; manually: text and a PNG round-trip both directions between Chrome and this box.
  - Depends on: 4.6, 5.1, 5.6

- [ ] **Task 6.3: Audio** `[agent]`
  - Files: `agent/swoop/src/audio/mod.rs`, `agent/swoop/src/audio/wasapi.rs`, `agent/swoop/src/audio/opus.rs`, `web/lib/swoop/audio.ts`, `web/components/swoop/SwoopAudioToggle.tsx`
  - Do: Fill the `audio` Feature (already registered as a no-op; do not edit `session/features.rs`). WASAPI loopback: `IAudioClient::Initialize` with `AUDCLNT_SHAREMODE_SHARED | AUDCLNT_STREAMFLAGS_LOOPBACK | AUDCLNT_STREAMFLAGS_EVENTCALLBACK` plus `SetEventHandle`, on a thread registered via `AvSetMmThreadCharacteristics("Pro Audio")`. Handle `AUDCLNT_BUFFERFLAGS_SILENT` and a `GetNextPacketSize()` of 0 by generating comfort silence so the Opus timeline never drifts. Encode Opus at **10 ms** frames, 48 kHz stereo, 96–128 kbps, `OPUS_APPLICATION_AUDIO`, **in-band FEC on**, **DTX off** (research `03` §9). Work behind the `audio-opus` cargo feature and do not enable it by default — Task 10.1 owns `Cargo.toml`. Send as an RTP audio track in **its own MediaStream**, never the video one, so the browser cannot A/V-sync and add video latency; fmtp carries `stereo=1; sprop-stereo=1; minptime=10; useinbandfec=1; usedtx=0`. With no render endpoint, emit `status` `audio: "no_endpoint"`; never create a virtual device and never change the default render endpoint. Browser: `audio.ts` exports `attach(session)`, starts **muted** and unmutes on the first user gesture; `SwoopAudioToggle.tsx` is a lucide `volume-2`/`volume-x` toggle with a disabled "no audio endpoint" state.
  - Done when: `cargo clippy --features audio-opus -- -D warnings` and `cargo test --features audio-opus` pass from `agent/swoop`; a unit test proves silence-fill keeps packet timestamps monotonic at 10 ms across a device gap; hardware tests are `#[ignore]`d with the manual command documented; `npx eslint` clean on both web files; observed: audio plays after the first click, mute takes effect immediately, and a machine whose audio device is disabled reports `no_endpoint` instead of stalling the session.
  - Depends on: 3.8, 4.1, 4.2

- [ ] **Task 6.4: Displays** `[agent+human]`
  - Files: `agent/swoop/src/displays/mod.rs`, `agent/swoop/src/displays/enumerate.rs`, `agent/swoop/src/displays/policy.rs`, `web/lib/swoop/displays.ts`, `web/components/swoop/SwoopDisplayPicker.tsx`
  - Do: Fill the `displays` Feature (already registered as a no-op; do not edit `session/features.rs`). Enumerate outputs through DXGI (`EnumOutputs` → `DXGI_OUTPUT_DESC`) keyed by the **stable device path, never the index** — a virtual display driver makes indices move (research `03` §10). Report per output: device path, friendly name, virtual-desktop rect (outputs left of or above the primary have **negative** coordinates), DPI scale and refresh, plus an "all outputs" virtual canvas. A per-output capture switch tears down and recreates duplication on the capture thread and forces a new IDR plus a decoder reconfigure. Downscale policy: keep the encoded size inside both encoder and decoder limits — H.264 max axis 4096, HEVC 8192, AMD 4096 on **both** axes — downscaling on the GPU (Task 4.5) to the largest legal size that preserves aspect, and reporting the scale factor in stats. Headless (no output, or duplication yields only black): emit `status` `displays: "headless"` and let the page show the lowercase dummy-plug message. swoop never calls `ChangeDisplaySettingsEx`/`SetDisplayConfig` — v1 has no per-machine display-config opt-in, so the code path must not exist. Include the virtual-desktop → output → client-canvas coordinate transform, and the cursor hotspot under non-100% scaling.
  - Done when: `cargo clippy -- -D warnings` and `cargo test` pass from `agent/swoop`, including a transform unit test over a negative-origin, mixed-DPI, mixed-refresh layout and a policy test that a 3×4K canvas picks a legal encode size per codec; `npx eslint` clean on both web files; the picker lists both monitors on this box with correct rects. Human: pull the display cables (or the dummy plug) and confirm the headless message appears, no display configuration changed, and the session recovers when they are reconnected.
  - Depends on: 3.6, 4.5, 5.1

- [ ] **Task 6.5: Quality menu + governor v2 + resolution change** `[agent]`
  - Files: `agent/swoop/src/session/quality.rs`, `agent/swoop/src/transport/governor.rs`, `web/components/swoop/SwoopQualityMenu.tsx`
  - Do: `quality.rs` defines the presets: `auto` (default), bandwidth caps (5/10/20/30/50 Mbps), resolution caps (native/1440p/1080p/720p), fps (60/30) and codec preference (auto/hevc/h264). A preset is a **ceiling** — the governor still adapts below it. Governor v2 in `governor.rs` consumes viewer feedback (arrival/decode/present plus app-level RTT, delivered by Tasks 3.12/4.7) and the transport estimate, and acts on bitrate first, then fps, then resolution, with hysteresis and a minimum dwell so it cannot oscillate. Keep a **floor frame rate on a static desktop** (≥ 1 fps) — hardware decoders stall otherwise (D5). A resolution change is always: a `reconfigure` control message so the browser calls `VideoDecoder.configure()`, **then** the new IDR; never emit a chunk whose references the client cannot have. Loss recovery stays **IDR with a 250–500 ms cooldown** on every encoder; reference invalidation/LTR is explicitly out of scope. Add stats fields: active preset, encoded size, target vs actual bitrate, fps, IDR count, governor state. `SwoopQualityMenu.tsx` writes through the existing session control channel.
  - Done when: `cargo clippy -- -D warnings` and `cargo test` pass from `agent/swoop`; a deterministic governor test replays a scripted feedback trace and asserts the ladder decisions with no oscillation; a test proves reconfigure-then-IDR ordering on a resolution change and that repeated loss reports inside the cooldown coalesce into one IDR; `npx eslint web/components/swoop/SwoopQualityMenu.tsx` clean; observed: switching presets mid-session never black-screens Chrome and never leaves the decoder erroring.
  - Depends on: 3.7, 4.7, 5.1

- [ ] **Task 6.6: Lease renewal + revocation** `[agent]`
  - Files: `web/lib/swoop/lease.ts`, `web/lib/swoop/revokeViewerSessions.server.ts`, `web/app/api/sites/[siteId]/members/[uid]/route.ts`, `web/lib/actions/removeSiteFromUser.server.ts`, `agent/swoop/src/viewers/lease.rs`, `web/__tests__/lib/swoop/lease.test.ts`
  - Do: Browser half — `lease.ts` exports `attach(session)` and silently renews the 5-minute lease at ~60% of its life via `POST …/swoop/sessions/{sid}/lease` (Task 3.2's route re-checks membership, site enablement and capability). On 401/403 it tears the session down with a lowercase toast; a hard stop lands at the 12 h absolute cap; tokens never go in a URL. Host half — `viewers/lease.rs` stores `lease_expires_at` derived from the bundle's authoritative time anchor plus monotonic elapsed, **never the kiosk clock** (review-2 M4); a viewer whose lease lapses past a ≤ 30 s grace is dropped, its peer connection closed, and **every key and button it held is released** (`SendInput` does not reset keyboard state — research `01` line 252); emit `viewer_left` with the reason. Revocation — `revokeViewerSessions.server.ts` exports `revokeSwoopSessionsForUser({ siteId, uid, reason })`, which ends that user's live `swoop_sessions` with an `endReason`, rings the Worker through `killSession` from `web/lib/swoop/signal.server.ts` (Task 2.4) — never a hand-rolled fetch — and writes the sid-only `swoop_kill` command. Call it **after** the membership write in the member route's DELETE (after `removeMember`, ~:192) and PATCH (after `changeRole`, ~:306 — a demotion loses `MACHINE_REMOTE_CONTROL`), and in `removeSiteFromUser.server.ts` after its `removeMember` loop. Fire it outside the Firestore transaction; never block the response on the ring.
  - Done when: `npm test` in `web/` covers renewal timing, the 12 h cap, 403 teardown, and that a removed **and** a demoted member's live sessions are revoked; `cargo clippy -- -D warnings` and `cargo test` pass from `agent/swoop` for the lapse → drop → release-all-keys path; `npx eslint` clean on every touched web file; measured: a removed member is dropped within one lease (≤ 5 min), and in ≤ 2 s when the ring path is healthy.
  - Depends on: 3.2, 5.1, 5.4

- [ ] **Task 6.7: Encoder breadth spike** `[human]`
  - Files: `dev/active/swoop/spikes/6.7-encoder-breadth.md`
  - Do: On the owner's Intel iGPU box, AMD box and this NVIDIA box as control, measure the candidate Intel/AMD encoder backends and pick one. The memo is the input to Task 7.1 and must name the chosen directory (`encode/qsv`, `encode/amf`, `encode/ffmpeg` or `encode/mf`) and cargo feature. Candidates: FFmpeg `hevc_qsv`/`h264_qsv` and `hevc_amf`/`h264_amf` (LGPL, dynamic link — Sunshine's path), native oneVPL and native AMF, and Media Foundation hardware MFT **only as a last resort** — the plan's own research says MF exposes the fewest low-latency knobs and OBS removed its MF encoders (review-1 F5). Also measure the software floor on a 4-core VM: openh264 vs the in-box MF software encoder; never x264 (GPL). Record per candidate: encode latency p50/p95 at 1080p60 and 4K60; rate-control adherence with a 1-frame VBV; whether a D3D11 BGRA texture is accepted zero-copy and the cost of the conversion pass when it is not; forced-IDR latency; whether bitrate reconfigures without an IDR; max resolution per codec (note AMF's 4096 cap on both axes); packaging size and licence obligations. Record LTR advertisement (`CODECAPI_AVEncVideoSupportedControls`) for information only — LTR is deferred.
  - Done when: the memo exists with every named measurement filled in or explicitly marked "not measurable on available hardware"; it names one backend for Task 7.1, the software choice for 7.2 and the fallback chain for 7.3; the losing candidates' numbers are recorded; the owner signs it off in the memo.
  - Depends on: none (long-lead owner action)
  - Blocks: 7.1, 7.2, 7.3

- [ ] **Task 6.8: TURN spike** `[human]`
  - Files: `dev/active/swoop/spikes/6.8-turn.md`
  - Do: On the owner's Cloudflare account. Create a Realtime TURN key (`POST /accounts/{id}/calls/turn_keys`, token with **Calls Write**); the response `key` is shown once — put it in the secret stores, never in the repo or the memo. Mint credentials both ways: `/credentials/generate-ice-servers` (browser shape) and `/credentials/generate` with `customIdentifier` — and answer explicitly whether `generate-ice-servers` accepts `customIdentifier`, because Task 8.4's metering depends on it. Force relayed sessions (`iceTransportPolicy: "relay"`) and measure the relay RTT delta against direct. Prototype a host-side allocation with a Rust TURN client over UDP 3478, then TLS 443; record the path MTU over TLS and whether ChannelData framing survives. Validate the billing asymmetry: run a metered transfer in **each** direction, then query `callsTurnUsageAdaptiveGroups` **one site at a time** (adaptive sampling makes multi-customer queries wrong) and report egress vs ingress. Measure shaping at 30 and 50 Mbps per allocation and the packet-rate ceiling (documented at 5–10 kpps).
  - Done when: the memo records where the key id and bearer live (not their values), every measurement above, a yes/no on `customIdentifier` for both mint endpoints, the measured billing direction, the relay bitrate cap to ship (25–30 Mbps) and the TLS degraded profile — the exact numbers Tasks 7.4, 7.6 and 8.4 implement; the owner signs it off.
  - Depends on: none (long-lead owner action)
  - Blocks: 7.4, 7.6, 8.4

## Wave 7: every GPU, every network

- [ ] **Task 7.1: Intel/AMD encoder backend** `[agent+human]`
  - Files: `agent/swoop/src/encode/<backend named by memo 6.7>/mod.rs` and that directory's submodules
  - Do: Implement the backend chosen in `dev/active/swoop/spikes/6.7-encoder-breadth.md`, in its own directory under `encode/`, behind the matching cargo feature (`encode-vpl`, `encode-amf`, `encode-ffmpeg` or `encode-mf`). Implement the same `Encoder` trait the NVENC backend (`encode/nvenc`, Task 3.7) implements — same methods, same error type — so the selector can hold both. Expose at the module root, with exactly these names, `pub fn probe() -> BackendCaps` (codecs, max width/height per codec, whether a D3D11 BGRA texture is accepted, measured max fps, concurrent-session budget) and `pub fn create(cfg: &EncoderConfig) -> Result<Box<dyn Encoder>>`; Task 7.3 calls only those two, `#[cfg(feature = …)]`-gated. Configure for latency: no B-frames, no lookahead, CBR with a one-frame VBV, infinite GOP with explicit IDR on demand, **single-slice frames** (a lost slice is a hard decode failure in current Chrome), and VPS/SPS/PPS in band with every IRAP. If the backend needs NV12, convert with Task 4.5's GPU path — never a CPU copy. Refuse sizes above the hardware cap (AMD: 4096 on both axes) rather than emitting a broken stream. Do not enable the feature by default.
  - Done when: `cargo clippy --features <feature> -- -D warnings` and `cargo test --features <feature>` pass from `agent/swoop`; hardware tests are `#[ignore]`d with their manual command in the module doc; a bitstream from this backend decodes in Chrome (record the page used). Human: run the ignored tests on the Intel and/or AMD box and paste the as-built encode-latency numbers into 6.7's memo.
  - Depends on: 3.7, 4.5, 6.7

- [ ] **Task 7.2: Software H.264 floor** `[agent]`
  - Files: `agent/swoop/src/encode/soft/mod.rs` and that directory's submodules
  - Do: The no-GPU floor, behind `encode-openh264` (or the MF-software feature if memo 6.7 chose it) — **never x264 (GPL)**, and no software HEVC. Implement the same `Encoder` trait as `encode/nvenc`, and expose the same two root symbols Task 7.3 calls: `pub fn probe() -> BackendCaps` and `pub fn create(cfg: &EncoderConfig) -> Result<Box<dyn Encoder>>`. Constrained-Baseline or Main, one slice per frame, no B-frames, infinite intra period with explicit IDR, CBR with a one-frame VBV, and the **H.264 VUI fix**: `bitstreamRestrictionFlag = 1` with `max_num_reorder_frames = 0` — without it Chrome's D3D11 decoder holds ~16 frames (208 ms instead of 8 ms; D5). Default ceiling 720p30 for a 4-core VM, with the measured ceiling reported through `probe()` so the selector can cap the session. Take the same BGRA frame the hardware path takes, converting on the CPU only when no GPU path exists, and cap worker threads so the encoder cannot starve the machine's real workload — these are signage boxes running TouchDesigner. Do not enable the feature by default.
  - Done when: `cargo clippy --features encode-openh264 -- -D warnings` and `cargo test --features encode-openh264` pass from `agent/swoop`; a golden test parses the emitted SPS and asserts `bitstreamRestrictionFlag = 1` and `max_num_reorder_frames = 0`; a 60 s 720p30 run on this box holds the target bitrate within ±10% with no frame-queue growth, and the numbers are recorded in the module doc.
  - Depends on: 3.7, 6.7

- [ ] **Task 7.3: Encoder selection + probe** `[agent]`
  - Files: `agent/swoop/src/encode/select.rs`, `agent/swoop/src/probe.rs`
  - Do: `select.rs` builds the fallback chain **NVENC → the Task 7.1 hardware backend → soft**, per codec, and picks the highest tier that satisfies the session's requested codec set and resolution. Reach every backend only through its two root symbols — `probe() -> BackendCaps` and `create(&EncoderConfig)` — each `#[cfg(feature = …)]`-gated, so the file compiles with every optional feature off. Selection must be table-driven and unit-testable over injected `BackendCaps`: no hardware required to test it. `probe.rs` implements the `probe` verb: enumerate DXGI adapters and their vendor ids (0x10DE NVIDIA, 0x8086 Intel, 0x1002 AMD), per-codec availability, max resolution per codec, capture availability, the resolved fallback chain, the measured **encoder budget** (concurrent sessions this machine can sustain — Task 8.2 consumes it) and the crate version. Print one JSON object on stdout and exit 0; exit **13** when no encoder exists at all. The key names are a contract for the memos and for Task 8.2's encoder budget, not for the heartbeat: `agent/src/swoop_capability.py` deliberately computes `capabilities.swoop` from binary presence alone (Task 2.2) and must not run `probe` on the heartbeat path — read that file, do not modify it. Never print bundle contents or credentials from `probe`.
  - Done when: `cargo clippy -- -D warnings` and `cargo test` pass from `agent/swoop` with no features and with each encoder feature; table-driven tests cover NVIDIA-only, Intel-only, no-GPU, and "HEVC requested but only H.264 available"; `owlette-swoop.exe probe` on this box prints JSON whose top-level keys match the names listed above, asserted by a unit test in this task; exit 13 when every backend is unavailable.
  - Depends on: 2.2, 3.7, 6.7

- [ ] **Task 7.4: Host-side TURN client** `[agent+human]`
  - Files: `agent/swoop/src/transport/turn/mod.rs`, `agent/swoop/src/transport/turn/alloc.rs`, `agent/swoop/src/transport/turn/tls.rs`
  - Do: Host-side TURN behind the `turn` cargo feature, using the TURN crate already declared in `Cargo.toml` — do not add crates; if it is absent, stop and log it. Allocate over UDP 3478 first, falling back to TLS 443. Implement Allocate with long-term credentials, Refresh at ~50% of the allocation lifetime (Cloudflare credential TTL is ≤ 48 h), CreatePermission per peer, and ChannelBind for the data path so every packet does not carry a Send-indication header. Credentials arrive **in the session bundle**, minted by the API — the streamer never fetches them and never logs them, not even the username. Surface the relay candidate to the ICE agent as a normal candidate and report the allocation lifetime and negotiated transport in `status`. Handle: allocation lost mid-session (re-allocate once, then degrade to browser-side relay), Cloudflare's drop heuristics (>5 new peer IPs/sec, 5–10 kpps) without retrying into them, and an expired permission. Host-side allocation is preferred because Cloudflare bills only server→client egress (D13), so the video direction is unbilled.
  - Done when: `cargo clippy --features turn -- -D warnings` and `cargo test --features turn` pass from `agent/swoop`; unit tests drive the Allocate/Refresh/CreatePermission/ChannelBind state machine over a mocked socket, including the re-allocate-once-then-degrade path; a test asserts no credential string appears in any log record at any level. Human: supply a Cloudflare TURN credential and run the `#[ignore]`d live test to confirm a forced-relay session connects over UDP 3478 and over TLS 443, and paste the RTT delta into 6.8's memo.
  - Depends on: 3.8, 3.9, 6.8

- [ ] **Task 7.5: ICE policy** `[agent]`
  - Files: `agent/swoop/src/transport/ice_policy.rs`, `web/lib/swoop/peer.ts`
  - Do: Host policy in `ice_policy.rs`: trickle every candidate, one bundled transport with rtcp-mux, and **never gather ICE-TCP host candidates** — browsers only produce `tcptype active` candidates toward TURN-TCP, so a passive listener is unreachable. Resolve `.local` mDNS candidates through the Windows resolver (`GetAddrInfoExW`/`DnsQueryEx`): without it a same-LAN browser cannot give a direct path, and a same-LAN session behind a non-hairpinning NAT falls all the way to relay. Promotion: exactly **one** deliberate attempt — if the selected pair is still `relay` at T+3 s, restart ICE with refreshed candidates; cap at one, no thrash. React to `disconnected` within ~2 s rather than waiting for `failed` (consent freshness kills media in 30 s), and restart on a Windows interface change (`NotifyIpInterfaceChange`). Browser half in `peer.ts`: `iceCandidatePoolSize: 1`, `iceTransportPolicy: "all"`, `bundlePolicy: "max-bundle"`, `restartIce()` on `disconnected` and `failed`, one restart for the relay→direct promotion, and **stage-2 browser-side TURN** — add browser relay servers only when the host reports it holds no allocation. The browser always offers; the host always answers.
  - Done when: `cargo clippy -- -D warnings` and `cargo test` pass from `agent/swoop`, covering the one-attempt promotion state machine, the `disconnected` timer and `.local` candidate parsing; `npm test` in `web/` covers the restart triggers and that browser TURN is added only when the host reports no allocation; `npx eslint web/lib/swoop/peer.ts` clean; observed: a same-LAN session selects a host or srflx pair, not relay.
  - Depends on: 3.8, 3.10

- [ ] **Task 7.6: Relay caps + degraded mode** `[agent]`
  - Files: `agent/swoop/src/transport/budget.rs`, `web/components/swoop/SwoopStatsOverlay.tsx`
  - Do: `budget.rs` classifies the live path **itself**, from the transport's selected-candidate-pair stats — `PathProfile::{Direct, RelayUdp, RelayTls}` — and returns `PathBudget { max_bitrate_bps, max_fps, max_fragment_size }`. Do not read anything from `ice_policy.rs`; Task 7.5 owns it this wave. Relayed sessions cap at 25–30 Mbps and prefer larger packets: Cloudflare shapes above ~50–100 Mbps and 5–10 kpps per allocation. The TLS/TCP degraded profile caps 4–8 Mbps at 30 fps and turns FEC off — TCP already retransmits, and head-of-line blocking turns one lost segment into a multi-frame stall. `max_fragment_size` comes from the relay path MTU measured in 6.8/7.4, not a constant. Do **not** edit `governor.rs` (Task 8.2 owns it this wave) or `pacer.rs`: read them to confirm whether they already consult `budget`, and if they do not, record that in the task log rather than editing them. `SwoopStatsOverlay.tsx` gains a lowercase indicator showing direct / relayed (udp) / relayed (tls), the active cap and the reason.
  - Done when: `cargo clippy -- -D warnings` and `cargo test` pass from `agent/swoop`; table-driven tests map each `PathProfile` plus MTU to the expected budget, including the TLS degraded profile and the fragment size; `npx eslint web/components/swoop/SwoopStatsOverlay.tsx` clean; a forced-relay session shows "relayed" within 2 s of connecting and never exceeds the cap.
  - Depends on: 3.8, 4.7, 6.8

- [ ] **Task 7.7: Enable/disable side effects + uninstall cleanup** `[agent+human]`
  - Files: `agent/src/swoop_manager.py`, `agent/owlette_installer.iss`, `agent/tests/unit/test_swoop_side_effects.py`
  - Do: **Read `.claude/skills/build-system.md` before touching the `.iss`, and get the owner's explicit ack for that edit** — it is a guardrailed file and only the three approved swoop edits are allowed. In `swoop_manager.py`, when swoop is enabled for this machine, apply two side effects on a worker thread (never on the 5-second loop; the service is already SYSTEM, so nothing elevates): (1) an idempotent inbound-UDP Windows Firewall allow rule named `Owlette swoop`, scoped to `{app}\swoop\owlette-swoop.exe`, plus inbound UDP 5353 for mDNS candidate resolution; (2) `HKLM\SOFTWARE\Microsoft\Windows\CurrentVersion\Policies\System\SoftwareSASGeneration = 3`, **recording the prior value — including "absent" — in local agent state first**. On disable, delete the rule and restore the recorded value exactly (delete the value when it was absent). Both paths log through `log_event` and never raise. In `owlette_installer.iss`, add `[UninstallRun]` entries that remove the rule and revert the policy, mirroring the existing powershell entries in that block (`runhidden waituntilterminated`, `exit 0` so a missing rule is not an error), and sweep `logs\swoop` and `ipc\swoop`.
  - Done when: `agent/.venv/Scripts/python -m pytest agent/tests/unit/test_swoop_side_effects.py` proves enable and disable are idempotent, restore the exact prior SAS value (absent → value deleted), run off the main loop and never elevate; `python -m py_compile agent/src/swoop_manager.py` clean. Human: ack the `.iss` edit; then upgrade from the **oldest fielded version** (not from dev), confirm no streamer is stranded, uninstall, and confirm the firewall rule is gone and `SoftwareSASGeneration` is back to its pre-install state.
  - Depends on: 2.1, 2.6, 5.4

- [ ] **Task 7.8: Signing dry run** `[human]`
  - Files: `dev/active/swoop/spikes/7.8-signing-dry-run.md`
  - Do: On the owner's Azure account. Create the Azure Trusted Signing account and start identity validation — it has a lead time, so start it before the rest of this memo. Record the account, certificate-profile and region names, the profile type (public trust) and how long validation took. Sign one throwaway spike exe end to end and verify it with `signtool verify /pa /v`. Then write the exact CI shape Task 8.6 will implement: the OIDC federated credential for this repo, `id-token: write` on the **build** job (`.github/workflows/build-installer.yml:78`), every action pinned by commit SHA with a `# vN` comment as the rest of this repo does, and the step's position — **before** the `compute base64-subjects` step at `:154`, because signing mutates bytes and that step hashes the SLSA subject the verify job re-hashes. Note that every shipped exe is signed (`owlette-swoop.exe`, `owlette-host.exe`, `owlette-desktop.exe`) plus the installer itself. Also write the Microsoft Defender false-positive submission procedure (the `Trojan:Win32/Bearfoos.B!ml` precedent) and an outline of the EDR allow-list document customers will need for a SYSTEM binary that captures the screen and injects input.
  - Done when: the memo exists with the account details (no secrets), the measured validation time, a verified-signature transcript for the spike exe, the exact workflow snippet 8.6 will adapt, the Defender submission steps and the EDR allow-list outline; the owner signs it off.
  - Depends on: none (long-lead owner action)
  - Blocks: 8.6

## Wave 8: multi-user and product integration

- [ ] **Task 8.1: Multi-user** `[agent]`
  - Files: `agent/swoop/src/viewers/mod.rs`, `agent/swoop/src/viewers/roster.rs`, `agent/swoop/src/viewers/input.rs` (all of `viewers/**` **except** `lease.rs`), `web/lib/swoop/presence.ts`, `web/components/swoop/SwoopPresence.tsx`
  - Do: The viewer roster and shared-input hygiene. Keep each viewer record's public fields named exactly `viewer_id`, `display_name`, `ctl`, `codec_class` and `lease_expires_at`, and keep them public: `session/tiers.rs` (Task 8.2) and `viewers/lease.rs` (Task 6.6) read them, and you must not edit either file. Enforce `ctl` from the **verified JWT**, never from anything the viewer sends: a view-only viewer's input messages are dropped and counted, and a sustained stream of them is reported to `/api/agent/swoop/events` as a host-side denial (those are the events that show an attack in progress). Shared input: keep modifier state **per viewer**, resolve to last-input-wins at the host, and on leave, kick or lease lapse release every key and button that viewer held — `SendInput` does not reset keyboard state, so a disconnect mid-chord leaves a stuck modifier. Publish each controller's cursor position so other viewers can draw it. Browser: `presence.ts` exports `attach(session)` and keeps the roster; `SwoopPresence.tsx` shows who is connected, who has control, and other viewers' cursors as overlay elements (the local cursor stays a CSS cursor).
  - Done when: `cargo clippy -- -D warnings` and `cargo test` pass from `agent/swoop` with tests for view-only input rejection and its denial report, per-viewer modifier state, release-all-on-leave, and last-input-wins ordering; `npm test` in `web/` covers the roster; `npx eslint` clean on both web files; observed: three viewers on this machine with one view-only — the view-only viewer cannot move the mouse, and no modifier sticks after any of them disconnects mid-chord.
  - Depends on: 4.3, 5.1, 6.6

- [ ] **Task 8.2: Encoder tiers + uplink budget** `[agent]`
  - Files: `agent/swoop/src/session/tiers.rs`, `agent/swoop/src/transport/governor.rs`
  - Do: `tiers.rs` computes **tiers = min(distinct codec classes present among viewers, the measured encoder budget from `probe`)** — never a hard-coded 2. Each tier owns one encoder instance; viewers are assigned to the tier matching their codec class, then their rate class. **Nobody is downgraded because another viewer's browser cannot decode HEVC** — that is the whole point of D14. Read viewers through the roster's public fields (`viewer_id`, `ctl`, `codec_class`); do not edit `viewers/**`, Task 8.1 owns it this wave. In `governor.rs`, add one **shared host uplink budget**: a single estimate for the machine's uplink, allocated across viewers proportional-fair with a per-viewer floor and **controllers served before watchers**, so N independent congestion controllers cannot each probe for the whole of the same bottleneck and bufferbloat a kiosk's DSL line. Coalesce keyframes: a join and any PLI falling inside the existing 250–500 ms IDR cooldown produce **one** IDR for that tier, not one per viewer. Cap concurrent viewers at the encoder budget and refuse beyond it with an audited reason.
  - Done when: `cargo clippy -- -D warnings` and `cargo test` pass from `agent/swoop`; unit tests prove three viewers across two codec classes on a 3-budget machine yields two tiers with nobody downgraded, a 1-budget machine degrades deterministically, a viewer joining a three-viewer session causes **at most one** IDR, the shared budget never allocates more than the estimate, and a watcher never starves a controller.
  - Depends on: 4.7, 6.5, 7.3

- [ ] **Task 8.3: Tray indicator** `[agent+human]`
  - Files: `agent/src/owlette_service.py`, `desktop/src-tauri/src/tray.rs`, `desktop/src/lib/serviceHealth.ts`
  - Do: Surface live swoop state locally. `OwletteService._write_service_status` (`agent/src/owlette_service.py:1177`) and `_write_service_status_early` (`:1138`) are the **only** writers of `tmp/service_status.json` — add a `swoop` block fed by `SwoopManager.status()`: `{active: bool, viewers: int, controllers: int, since: int}`, where `active` means **capture is running**, not "a process is alive" (the 60 s linger must not keep the badge lit). Add `active` and `viewers` to the write-throttle signature tuple (`:1261-1288`) so a session start or end forces an immediate write instead of waiting out `MIN_STATUS_WRITE_INTERVAL = 30`. Keep the early-write shape identical — readers must never have to distinguish "key absent" from "off", so write the zero shape there. Mirror the new field in `desktop/src/lib/serviceHealth.ts:13` so the config window does not reject the document. In `tray.rs`, extend `TrayView` (`:113`) and `read_status_doc` (`:699`), add a lowercase menu line via `apply_menu` (`:595`) and a tooltip line (`:975`), and raise an optional toast through `notify` (`:908`) on session start — gated on the `indicator` policy the streamer receives in its bundle and reports back in its `status` event, which `SwoopManager.status()` carries into `tmp/service_status.json`. The agent reads no `sites/{s}/settings/*` document — it has no such path today and this task does not add one.
  - Done when: `agent/.venv/Scripts/python -m pytest agent/tests/` passes, including a new test that a session start forces an immediate status write and that the swoop block is present in both writers; `cargo clippy -- -D warnings` and `cargo test` pass with the working directory `desktop/src-tauri`; `cd desktop && npx tauri build --no-bundle` succeeds. Human: start a session and confirm the tooltip, menu line and (where the site policy enables it) the toast appear within ~2 s and clear within ~2 s of the last viewer leaving.
  - Depends on: 2.1, 5.1, 5.4

- [ ] **Task 8.4: Relayed-GB metering** `[agent+human]`
  - Files: `web/lib/swoop/metering.server.ts`, `web/app/api/cron/swoop-metering/route.ts`, `infra/cron-jobs.json`, `scripts/env-manifest.json`, `web/content/docs/dashboard/swoop-usage.mdx`, `web/__tests__/lib/swoop/metering.test.ts`
  - Do: `metering.server.ts` queries Cloudflare GraphQL (`https://api.cloudflare.com/client/v4/graphql`, dataset `callsTurnUsageAdaptiveGroups`, metrics `egressBytes`/`ingressBytes`, filtered by `customIdentifier`) **one site per query** — adaptive sampling makes a multi-site query wrong — and writes a per-site rollup (relayed GB, session count, period) to Firestore through the admin SDK. `customIdentifier` is whatever memo 6.8 confirmed the credential mint sets (`site:<siteId>`). The cron route follows the house pattern exactly: `export const GET`, an inline `request.headers.get('x-cron-secret')` comparison against `process.env.CRON_SECRET` returning 401, nothing else (see `web/app/api/cron/retention/route.ts:91-94`). Register it in `infra/cron-jobs.json` with the full entry shape (`id, path, method, authHeader, authScheme, authEnvVar, schedule, cadenceLabel, minTimeoutSeconds, environments:["dev","prod"], urls:{dev,prod}, purpose, failureMode, detectedBy, sourceFile`) — `web/__tests__/infra/cronJobs.test.ts` fails the build otherwise. Add `CLOUDFLARE_ACCOUNT_ID` (class `config`) and `CLOUDFLARE_ANALYTICS_API_TOKEN` (class `secret`) to `scripts/env-manifest.json`. Write `swoop-usage.mdx` modelled on `web/content/docs/cli/reference/quota.mdx` (two-key lowercase front matter, prose lead, tables, `## notes` ending in a `- **related**:` link). **Do not edit any `meta.json` — Task 8.5 registers both new docs pages.**
  - Done when: `cd web && npm test -- cronJobs` and the new metering tests pass; `node scripts/sync-env.mjs check` reports no drift; `npx eslint` clean on every touched file; the docs page renders. Human: create the Cloudflare API token with Account Analytics, set both env vars on dev and prod, register the job twice on cron-job.org with each environment's `CRON_SECRET`, and confirm one site's rollup matches the Cloudflare dashboard.
  - Depends on: 3.2, 6.8, 7.4

- [ ] **Task 8.5: CLI + OpenAPI + docs** `[agent]`
  - Files: `cli/src/lib/openBrowser.ts`, `cli/src/commands/swoop.ts`, `cli/src/commands/auth.ts`, `cli/src/commands/machine.ts`, `cli/src/index.ts`, `cli/__tests__/commands/swoop-http.test.ts`, `cli/__tests__/commands/stubs.test.ts`, `web/openapi.yaml`, `web/content/docs/dashboard/swoop.mdx`, `web/content/docs/dashboard/meta.json`, `web/content/docs/cli/reference/swoop.mdx`, `web/content/docs/cli/reference/meta.json`
  - Do: Lift `tryOpenBrowser` out of `cli/src/commands/auth.ts:100` into `cli/src/lib/openBrowser.ts` as `export function openBrowser(url: string): void` — same URL validation, same platform switch, same best-effort behaviour — and have `auth.ts` import it with no behaviour change. `cli/src/commands/swoop.ts` registers `owlette swoop <machineId> --site <siteId>`: resolve the machine, check `capabilities.swoop`, print `<apiUrl>/swoop/<siteId>/<machineId>` and open it; `--no-open` prints only, `--json` emits the url. The CLI never mints a viewer token and never touches the media path — step-up happens in the browser. Repoint the `machine live-view` stub's `reason` at `owlette swoop` and update the assertions in `cli/__tests__/commands/stubs.test.ts:39-42,158`. Register the command in `cli/src/index.ts`. Add the swoop user routes to `web/openapi.yaml` beside the other machine routes (`…/swoop/sessions`, `…/swoop/sessions/{sid}`, `…/swoop/sessions/{sid}/lease`, `…/swoop/kill`, `/api/sites/{siteId}/swoop-settings`), documenting the 403 `api_key_not_permitted` response. Write both docs pages in lowercase, and register `swoop` **and** `swoop-usage` (Task 8.4's page) in `web/content/docs/dashboard/meta.json`, plus `swoop` in the cli reference `meta.json`.
  - Done when: `cd cli && npm test` passes including the new http test and the updated stub assertions; `npx eslint` clean on every touched file; the api-contracts e2e spec still passes against the edited `web/openapi.yaml`; both docs pages appear in the nav and their links resolve.
  - Depends on: 3.2, 5.2, 5.3

- [ ] **Task 8.6: Signing in the release pipeline** `[agent+human]`
  - Files: `.github/workflows/build-installer.yml`
  - Do: Implement the signing shape recorded in `dev/active/swoop/spikes/7.8-signing-dry-run.md`. Add `id-token: write` to the **build** job's `permissions` block (`:78`) — not to the top-level block — and an Azure OIDC login plus a Trusted Signing step that signs every shipped exe (`owlette-swoop.exe`, `owlette-host.exe`, `owlette-desktop.exe`) before they are assembled into the installer payload, then signs `Owlette-Installer-v<version>.exe` itself. All of it must happen **before** the `compute base64-subjects` step at `:154`: signing mutates bytes, and signing afterwards makes `slsa-verifier` fail on every tagged release. Pin every new action by commit SHA with a `# vN` comment, as the rest of this repo does. Fail the build loudly when a file that should be signed is missing or when `signtool verify /pa` fails — a silently unsigned release is worse than a red build. Secrets come from repo secrets and the OIDC federated credential; never inline a certificate or tenant secret, never echo a token.
  - Done when: `zizmor` is clean on the edited workflow; a `workflow_dispatch` run produces an installer whose `signtool verify /pa /v` succeeds and whose SLSA provenance still verifies end to end; the build stays inside its `timeout-minutes`. Human: create the Azure OIDC federated credential and the repo secrets for the Trusted Signing account, trigger the dispatch run, and confirm the verified publisher name on the downloaded installer.
  - Depends on: 2.6, 7.8

- [ ] **Task 8.7: E2E + integration tests** `[agent]`
  - Files: `web/e2e/specs/swoop/session.spec.ts`, `web/e2e/specs/swoop/permissions.spec.ts`, `web/e2e/helpers/swoopHost.ts`, `agent/swoop/src/capture/testpattern.rs`, `agent/tests/integration/test_swoop_streamer.py`
  - Do: Browser side — `swoopHost.ts` is an **in-browser fake host peer**: it creates the answering `RTCPeerConnection` inside the page, so the specs exercise signaling, admission, the viewer JWT and the presentation path without a Windows host. Decode coverage goes only as far as the browser-matrix memo from Task 2.12 says the bundled Chromium allows — CI installs plain Chromium, which ships without proprietary codecs, so assert at the reassembly / `VideoDecoder.configure()` boundary with a stubbed decoder unless that memo says otherwise. Cover: a member is refused control, an api-key caller is refused outright (`api_key_not_permitted`), a request without a live step-up proof is refused, and the kill switch ends a live session. Use `web/e2e/helpers/roles.ts` and `seed.ts`; model the spec on `web/e2e/specs/settings/api-keys.spec.ts`. Host side — `capture/testpattern.rs` produces a deterministic moving pattern with an embedded frame counter, selected through the bundle's optional `overrides` object (`{"source":"testpattern","encoder":"soft"}`); **do not edit `main.rs`**. `test_swoop_streamer.py` spawns the built streamer with a synthetic bundle on stdin and asserts the `ready` → `viewer_joined` → `exiting` event sequence, the documented exit codes, and that no bundle field ever reaches a log.
  - Done when: `cd web && npm run e2e` passes locally including both new specs; `agent/.venv/Scripts/python -m pytest agent/tests/` passes, with the integration test skipping with a clear reason when the exe is not built; `cargo clippy --features encode-openh264 -- -D warnings` and `cargo test --features encode-openh264` pass from `agent/swoop`; `cargo test --features testhooks` covers the override path, and a test asserts a default-feature build rejects a bundle carrying `overrides` with exit 10; `npx eslint` clean on the new web files.
  - Depends on: 2.12, 3.9, 5.2, 7.2

## Wave 9: `#[cfg]` platform seams

- [ ] **Task 9.1: `#[cfg]` platform seams** `[agent]`
  - Files: `agent/swoop/src/platform/mod.rs`, `agent/swoop/src/platform/windows.rs`, `agent/swoop/src/platform/macos.rs`, `agent/swoop/src/platform/linux.rs`, `agent/swoop/src/main.rs`, `.github/workflows/rust-build.yml`
  - Do: Turn `platform/` into the documented seam the tri-platform plan's Wave 8 fills. Define traits for capture source, encoder factory, input injector, cursor source, clipboard, audio source, and — the one the delivery review says is missing — **process lifetime and bundle delivery**: "who owns my lifetime, and where does my bundle come from". On Windows the streamer is a child of the SYSTEM service in the console session, held in a Job Object with `KILL_ON_JOB_CLOSE` and the bundle on an inherited stdin pipe; on macOS/Linux it is a child of the user's desktop app (cross-plan rule C2), which is what carries TCC responsibility. Implement `windows.rs` purely by delegating to the existing modules — no behaviour change anywhere. Write `macos.rs` and `linux.rs` as compiling stubs returning `Unsupported`, each with a doc comment naming what a real backend must implement: macOS = ScreenCaptureKit + VideoToolbox, **Apple silicon only, macOS 15.0 floor**; Linux = X11/XShm (Wayland out of scope) with VAAPI or NVENC. Re-home every Windows-only module declaration behind `#[cfg(windows)]` in `main.rs` — the one exception to the no-`main.rs` rule, stated in the standing rules, and only for declarations Task 1.2 did not already gate — so the ubuntu and macos legs compile against the platform stubs; behaviour on Windows is unchanged. Add `ubuntu-latest` and `macos-latest` `cargo check` legs to `.github/workflows/rust-build.yml`, copying the shape of `.github/workflows/agent-tests.yml` (SHA-pinned actions with `# vN`, least-privilege `permissions`, `concurrency`, `timeout-minutes`, path filters).
  - Done when: `cargo clippy -- -D warnings` and `cargo test` pass from `agent/swoop` on Windows with the full Wave 3–8 suite still green and no behaviour change; the ubuntu and macos legs of `rust-build.yml` go green on a push to `dev`; `zizmor` is clean on the edited workflow.
  - Depends on: 2.5, and the host modules from Waves 3–8

## Wave 10: release (gate G4)

- [ ] **Task 10.1: Release** `[agent+human]`
  - Files: `agent/swoop/Cargo.toml`, `docs/changelog.md`, `web/content/docs/changelog.mdx`, `/VERSION`, `agent/VERSION`, `web/package.json` (the last three only via `node scripts/sync-versions.js X.Y.Z`), `dev/active/swoop/spikes/10.1-ga-measurements.md`
  - Do: Finalise `[features] default = [...]` in `agent/swoop/Cargo.toml` — **this is the one task that changes that file** — enabling exactly the backends Tasks 7.1/7.2/7.3 proved plus `turn` and `audio-opus`, on top of the `encode-nvenc` Task 1.2 put there. `testhooks` is **never** in `default`: it gates Task 8.7's bundle `overrides` hook, and a shipped binary must reject a bundle carrying `overrides` with exit 10. Keep `[package] version` the first line in the file matching `^version = "X.Y.Z"`: `scripts/sync-versions.js` rewrites only the first match, so a dependency table with a three-component version above it would be stamped instead. Then, strictly in this order: run `node scripts/check-security-alerts.mjs` (exit 1 stops the release — fix it, dismiss it on GitHub with a written reason, or get the owner's explicit acceptance and list every ack with its reason in the release commit body; never ack on your own judgment); write the `## [X.Y.Z] - YYYY-MM-DD` entry into **both** `docs/changelog.md` and `web/content/docs/changelog.mdx`; run `node scripts/sync-versions.js X.Y.Z`; commit — **then** build per `.claude/skills/build-system.md` (non-interactive invocation with stdin from NUL, in the background). Record pilot measurements against every success criterion in `plan.md` in `10.1-ga-measurements.md`, plus the EDR allow-list document. Work on `dev`; never push to `main`.
  - Done when: the G4 checklist in the memo is complete — every `plan.md` success criterion carries a measured number or an explicit miss; every shipped binary is Authenticode-signed; **the install-directory security release has shipped**; `node scripts/check-security-alerts.mjs` exits 0; the agent suite, web unit tests, rules tests and e2e are green. Human: sign off the measurements, approve the version number, authorise and run the installer upload + finalize (mutating calls), and confirm an upgrade from the oldest fielded version on a real machine.
  - Depends on: 6.1–6.6, 7.1–7.7, 8.1–8.7, 9.1, and the separately-planned install-directory security release

## Wave 11: legacy live view removal (gated on the fleet floor)

- [ ] **Task 11.1: Legacy live view removal (gated on the fleet floor)** `[agent+human]`
  - Files: `web/components/LiveViewModal.tsx` (delete), `web/components/MachineContextMenu.tsx`, `web/app/dashboard/page.tsx`, `web/app/dashboard/components/MachineCardView.tsx`, `web/app/dashboard/components/MachineListView.tsx`, `web/hooks/useFirestore.ts`, `web/lib/actions/executeMachineCommand.server.ts`, `web/app/api/sites/[siteId]/machines/[machineId]/commands/route.ts`, `web/openapi.yaml`, `cli/src/commands/machine.ts`, `cli/__tests__/commands/stubs.test.ts`, `agent/src/owlette_service.py`, `agent/tests/unit/test_screenshot_paths.py`, `web/__tests__/api/sites-machines-commands.test.ts`, `web/__tests__/lib/actions/executeMachineCommand.test.ts`, `web/content/docs/agent/remote-commands.mdx`, `web/content/docs/reference/agent-commands.mdx`
  - Do: **Gate first.** Do not start until the fleet floor is the swoop agent version, confirmed against the live API — not inferred from the repo. No machine may ever have neither live view nor swoop. Then remove the screenshot-slideshow live view in lockstep across its four coupled surfaces: `ALLOWED_COMMAND_TYPES` (`executeMachineCommand.server.ts:31-32`), `VIEW_COMMAND_TYPES` and the `start_live_view` branch (`commands/route.ts:351-352` and `:177`), `web/openapi.yaml:5255`, and the CLI. Delete `LiveViewModal.tsx` and its dashboard wiring (the `MachineContextMenu.tsx` live-view item, `page.tsx` dialog state and handlers, the card/list prop pass-throughs), the `useFirestore.ts` `liveView` fields and helpers (`:285-295`, `:1740-1750`), the agent's `_handle_start_live_view` (`:7268`), `_handle_stop_live_view` (`:7305`), `_live_view_loop` (`:7315`) and their dispatch entries (`:5382-5386`), the CLI stub and its test, and the two docs tables. **`/api/agent/screenshot` and `_handle_capture_screenshot` (`:7180`) stay** — crash screenshots and cortex use them; update `test_screenshot_paths.py` to pin the two remaining pipelines instead of three and delete nothing else it covers.
  - Done when: `grep -rn "start_live_view\|stop_live_view\|liveView\|LiveViewModal" web/ agent/src/ cli/ docs/ web/content/` returns only changelog history; in `web/`: `npm test`, `npm run test:rules`, `npm run e2e`, `npx tsc --noEmit` and `npm run lint` all pass; `cd cli && npm test` passes; `agent/.venv/Scripts/python -m pytest agent/tests/` passes; all three screenshot pipelines (on-demand, crash, cortex) still work on this box. Human: confirm the fleet floor against the live API — the prod key is installer-scoped and cannot make that site/machine query — and authorise the removal.
  - Depends on: 10.1

## Deferred tracks

Not tasks. Each gets its own `/plan` when its trigger fires (copied from `plan.md`):

- virtual display driver (IddCx, EV cert + attestation signing)
- process split (mandatory in v1 only if a C++ transport wins G1)
- second video path
- NVENC reference invalidation / LTR
- Windows.Graphics.Capture helper
- touch / mobile viewer
- file transfer
- SFU for N ≥ 4 viewers
- UPnP opt-in

## Log
### 2026-09-17
- Plan re-created after the 2026-09-16 data loss. Seven research reports, three adversarial reviews (latency,
  security, delivery) and four drafting passes; evidence in `research/`. Owner rulings recorded at the top of
  plan.md. Ready for execution: start with Wave 0. Prerequisite outside this plan: the install-directory
  security release.

### 2026-09-17 — Wave 0 executed (7 of 11)

Ran the seven agent-completable tasks in parallel, each in a fresh context: **0.4, 0.5, 0.6, 0.7, 0.8,
0.9, 0.11**. Gates verified independently, not taken from the agents' reports: `web` `npx tsc --noEmit`
exit 0; `cli` build clean and 278 tests passing; `agent` `py_compile` OK; `capture-probe` clippy clean
with 18 passed / 4 ignored; `nvenc-probe` clippy clean with 27/27.

Committed and pushed to `feat/swoop` (`e2fd8187`, `dec53290`, `a66866d8`, `0ac2cbf8`, `3e186705`).

**Not started — all four are blocked on the owner's hardware or hands, not on anything in the repo:**
0.1 (≥240 fps camera or photodiode), 0.2 (elevated impairment tool + camera + G1 sign-off; also the
largest single item in the wave), 0.3 (elevated console, Win+L, a real UAC prompt, a reboot to the logon
screen), 0.10 (Safari on macOS and Firefox, neither on this box). **Gate G1 is therefore not reached and
Wave 1 must not start** — 1.1, 1.2, 2.5, 2.6, 3.8, 3.10, 3.11 are all written against 0.2's winner.

**Two memos are deliberately NOT committed** and must not be pushed until the install-directory
hardening release has shipped and its hold has elapsed, because this repository is public:
`spikes/0.5-threat-model.md` and `spikes/0.7-install-dir-cleanup.md`. Same rule, and the same reason,
that already holds back `research/review-2-security.md`; each file carries its own banner saying so.
`dev/active/` is gitignored, so only a deliberate `git add -f` can leak them.

**Amendments other tasks need — found by Wave 0, not yet applied to the task text:**

- **Task 3.1 is wrong as written** (from 0.6). It says to set the doorbell shutdown event in `SvcStop`
  (`owlette_service.py:1952-1956`), but under `owlette-host` the SCM watcher reaches `graceful_shutdown`
  at `:1653`/`:1660` **without `SvcStop` running at all** — that is the normal production path since
  3.0.0, and the watcher's own log string at `:1657` says so. Set the event inside `graceful_shutdown`
  (idempotent, one-shot under `_shutdown_lock`); keep the `SvcStop` line as belt and braces.
- **Task 2.1 needs an `on_refresh` callback** and **2.3 a `refresh_now()`** (from 0.6) — otherwise
  `swoop_refresh` has no route to the doorbell at all. No command-contract change.
- **Task 3.3's `/api/agent/swoop/doorbell-token` must return `expiresIn`** (from 0.6), or the refresh
  deadline has to be computed from a parsed JWT against the kiosk clock.
- **Task 2.8 needs a distinguishable auth close reason** (from 0.6) or the free re-mint on a `kid`
  rotation cannot be triggered and every machine eats a full backoff ladder.
- **Task 3.2 must never ring an unconnected machine; 2.8 should refuse it** (from 0.4) — whoever touches
  a room name first permanently homes that Durable Object, so a ring to a machine whose agent has never
  dialled homes the room near the API's colo, forever.
- **Tasks 1.4 / 2.8: no alarm, timer or held outbound fetch in the DO** (from 0.4). It breaks hibernation
  and turns the GB-s line from $0 into roughly $41,500/month at 10,000 rooms. Carry the spike's
  bare-`ping`→`pong` test into the product suite as the regression guard.
- **Task 3.7: drop the `max_dec_frame_buffering = 0` assertion** (from 0.9) — NVENC has no field for it
  and emits 4; only `max_num_reorder_frames = 0` removes the delay. Also re-budget encode at 8–12 ms,
  not the 1–3 ms in `research/03-windows-host-stack.md` §2.2 — that is 15–20% of the 55 ms p50
  end-to-end criterion.
- **Task 7.3's `probe` must not infer NVENC from "an NVIDIA adapter exists"** (from 0.8) — this box
  reports two, and the Parsec VDD is byte-identical to the real GPU by description, vendor id, subsys
  and VRAM.
- **Task 1.2: give the product crate `exclude = ["spikes"]`** (from 0.8) so `cargo package`/`publish`
  does not trip over the nested spike manifests.
- **Task 6.1: `sas.dll` is loaded by the python service, not the streamer** (from 0.7) — it needs an
  absolute path too.

**Cross-plan finding — blocks the install-directory hardening release, not swoop** (from 0.7):
`install-dir-hardening/plan.md:59`'s `/reset` wording is ambiguous and, read the obvious way, silently
undoes the protection it was just applied. It needs an explicit wildcard — `icacls "<dir>\*" /reset /T
/C /Q` — so the reset reaches the children only. That plan's wording must be fixed before its Task 1.2
writes the command. Measurement and rationale are in the held 0.7 memo; not applied here, it is a
separate plan.

**Two items awaiting an owner decision** (from 0.7): record the prior `SoftwareSASGeneration` value in
`HKLM\SOFTWARE\Owlette` rather than in a file under the data root — reasoning is in the held 0.7 memo,
section 6; and gate the inbound UDP 5353 mDNS firewall rule on mDNS actually landing, since plan.md D4
records that str0m has no mDNS client and in v1 nothing would listen on it. One more from 0.9: `cudarc`
arrives transitively through `moq-nvenc` and is never called (the device is D3D11) — adopting
`moq-nvenc` as the product binding needs a decision on it.

**Unrelated, found in passing:** the CLI lint gate is dead. `cli/package.json:35` is
`eslint 'src/**/*.ts'`, and npm runs lifecycle scripts through `cmd.exe` on Windows, which does not strip
the single quotes, so the glob matches nothing and eslint exits 2. Even with that fixed,
`cli/eslint.config.mjs:6` imports `typescript-eslint`, which is absent from `cli/package.json` and
installed nowhere resolvable from `cli/`. Fixing it needs a devDependency, so it was left alone.

### 2026-09-17 — Wave 1 partial (3 of 5)

Ran **1.3, 1.4, 1.5** in parallel — the three marked "Depends on: none". Verified after all three had
settled, not per-agent: `web` `npx tsc --noEmit` exit 0; eslint clean across all eleven touched web files;
`web` full suite 264 suites / 5234 passed / 1 skipped; `agent` full suite 1196 passed / 6 skipped (the
pre-existing POSIX-only and win32gui skips, unchanged). Committed to `feat/swoop`.

**1.1 and 1.2 deliberately not started — they are gated on G1, by their own dependency lines.** 1.2 sets
`rust-version` to *spike 0.2's MSRV* and adds *the G1 transport crate* to `Cargo.toml`; 1.1 writes
`PROTOCOL.md`'s channel and track layout against *the G1 winner*. Neither value exists, because 0.2 has
not run. Starting them would mean inventing a transport and an MSRV that every later task then inherits —
the precise failure the gate exists to prevent. **Wave 2 onward is blocked behind the same gate.**

**Carried into the code from Wave 0:** 1.5 implements 0.7's finding L2 — `get_swoop_dir()` never creates
the directory and `{app}\swoop` is absent from `ensure_data_directories()`. The installer lays that
directory down as SYSTEM with a protected DACL; the agent creating it instead would defeat that, for the
reason recorded in the held 0.7 memo under L2. Absent means swoop is not installed. A short form of the
reason lives in the docstring so a later tidy-up does not undo it, and a unit case asserts the directory
is not created.

**Open items this wave produced:**

- **`SWOOP_MIN_AGENT_VERSION` is provisional at `3.4.0`** (`web/lib/versionUtils.ts`). Nothing in the plan
  pins the swoop release version; the constant is advisory copy only and the real gate is
  `capabilities.swoop == 1`. Task 10.1 must confirm it against the installer that actually ships.
- **Vercel edge-runtime env resolution is unverified** (from 1.4). If Next inlines `process.env` at build
  time on Vercel, `SWOOP_SIGNAL_URL` must be present in the Vercel *build* env, not only the runtime env,
  or the swoop `connect-src` entry will be missing on the failover origin — a CSP block that appears only
  during a failover. Confirm when the value is provisioned.
- **`BYPASS_EXEMPT_CAPABILITIES` was exported rather than module-private** (from 1.3), so a test can pin
  its contents to exactly the two capabilities and a third added later fails that test. Revert to private
  if that is not wanted.
- **`authorizedPlatformHandler` was deliberately left alone** (from 1.3). It repeats the
  `capability_enforcement` guard but is unreachable for these two capabilities: it hard-denies any actor
  whose global role is not `superadmin` before the capability check, and superadmin short-circuits
  `hasCapability`. Only the site handler carries the carve-out.
- **A docs table is now incomplete** (from 1.3): `web/content/docs/dashboard/admin/index.mdx:63` is a
  hand-maintained capability x role table that still lists only `MACHINE_VIEW`. Nothing tests it, so
  nothing is red. Add it to Task 8.5's file list.
- **`context.md:57` has a stale line number**: it puts `cleanup_old_logs` at `:1110`; it was at `:1097`
  before 1.5 and is at `:1126` after. Re-locate by symbol.

### 2026-09-18 — Tasks 0.1 and 0.2, agent halves complete. **G1 NOT reached.**

Both tasks stay **unchecked**: each has a human half outstanding and 0.2's done-when includes owner
sign-off. Progress stays 10/80. Commits `3f133ab7` (0.1), `4d20f1b6` / `ef616528` / `90c1370c` (0.2
stages 1–3).

**0.1** built the harness and the measurement contract every later latency number is quoted in. Key
measured results: hook→vblank 10.22 ms p50 (n=190); the compositor wait is **10.07 ms, not the 8.33 ms**
a half-frame assumption gives, so any budget carrying 8.3 ms under-counts. QPC↔`performance.now()` offset
±0.199 ms at n=400, drifting 1.31 ppm — measure once per session, and **±0.2 ms is the floor on how finely
any cross-clock stage may be quoted.** `C_photon(60 Hz) = 10.1 ms + S`, S PENDING. Two contradictions of
the research: review-1 **F7 does not reproduce** on Chrome 153 (24 readback configurations all returned
correct pixels; the rule stands but the reason is cost, 0.6–2.3 ms, not emptiness), and rAF's `timestamp`
ran 16.1 ms negative relative to a preceding draw, supporting D17.

**0.2** measured all three arms, same-machine only.

| arm | `_rv` p50 | `_rv` p95 |
| --- | --- | --- |
| A — DataChannel + WebCodecs | 13.15 | 14.5–15.6 (4 modes, tight) |
| B — RTP → `<video>` | 15.48 | 30.7–82.1 (9 runs, scattered) |
| C — RTCRtpScriptTransform | 22.53 | 30.7 |

**D3 was amended by owner ruling (2026-09-18)** and the amendment is recorded in the memo §2 *before* the
deciding rows existed, so it cannot be tuned to them. Original: winner beats B by ≥15 ms **p50** on LAN.
Amended: ≥15 ms p50 **or** betters B's p95 by ≥15 ms, and does not lose at 2% loss / 40 ms RTT; ties still
go to the simpler path. Reason: the p50 rule was blind to a tail 2–4× worse on arm B, which is visible
stutter in an interactive product. **The amendment changes the winner** — under the original rule arm A's
5.7 ms margin lost to the tie-break and B survived; under the amended rule A clears the p95 clause against
every B figure measured here. **Arm C is out** either way: it fails the clause and loses on p50.

**G1 cannot be closed.** The two rows the rule is decided on do not exist: the **real LAN hop** (needs a
browser on a second physical machine) and the **impaired matrix**. §13 is provisional and says so in the
memo's first line. Sign-off, when it happens, means agreeing to the amended rule and to arm C's exclusion —
**not** to a transport. The transport decision waits for those rows.

**clumsy 0.3 cannot express the specified impairment.** It has lag, drop, throttle, duplicate,
out-of-order, tamper, TCP RST and bandwidth — and **no jitter module**. 2% loss and 40 ms RTT are
producible; the **10 ms jitter term is not**, and `throttle` / `out-of-order` are not jitter. The matrix
will run with that cell explicitly unproduced rather than approximated and labelled as if it were the
specified condition. `tc netem delay 20ms 5ms distribution normal` on a box in the path is what would
express it — a hardware request, not a software one. Also: the clumsy filter must be **`udp` only**, because
the QPC clock exchange runs over TCP 17441 and impairing it would take the offset from ±0.25 ms to ~±20 ms
and invalidate every cross-clock figure in the impaired row.

**Findings that bear on D4, not D3** (memo §13.4): str0m's pacer is **not usable as configured** — BWE on
gives pacer queue delay p50 1015.6 / p95 1437.3 ms, 87% of the end-to-end figure, GoogCC settling at
8.9 Mbps on loopback against a 20 Mbps encoder, with **zero loss, zero PLI and zero NACK in `getStats`**, so
nothing standard reveals it. The measured SCTP ceiling is ~163–166 Mbps. review-1 **F1's predicted failure
does not occur** — 0 `Channel::write()` refusals at 50 Mbps on stock str0m, because the 1200 B fragment is
one SCTP chunk and F1's arithmetic assumed whole-frame messages. Of the four proposed patches, **one is
measured harmful**: raising `MAX_BUFFERED_ACROSS_STREAMS` from 128 KiB to 2 MB dropped carried throughput
from 100 to 42.3 Mbps with the buffer pegged — `sctp-proto` has no pacer, so the room becomes standing
queue and the 128 KiB cap is doing useful work as an accidental latency bound. Left opt-in. `wincrypto`
does **not** interoperate with Chrome 153; `wincrypto-dimpl` does. MSRV floor is **1.91.0**, set by
`moq-nvenc`, not str0m.

**A research question is closed**: the receive-side `RTCRtpScriptTransform` sits **after** Chrome's frame
buffer — 1.39 ms vs 10.67 ms push-to-hand-off on the same sender. research/01 §1(e) was right, research/02
§4.6's open question is answered, and it is why arm C cannot reclaim the jitter buffer.

**Outstanding for the owner**, both with copy-paste protocols in the memo: the LAN row (§9, host
192.168.88.10, port 17440, program-scoped firewall rule — str0m binds ephemeral ports, 51 distinct values
across 53 runs, so a port-scoped rule is impossible) and the impaired matrix (§10, clumsy elevated). Also
still pending: every photon number, the ≥120 Hz row (present and empty — no such display on this box),
goodput at 1/2% loss, single-frame-loss recovery, congestion-control step response, arm A's ICE restart,
and HEVC on arms A and C.

### 2026-09-18 — **gate G1 CLOSED. the video path is arm B.**

owner signed off on the LAN rows. 0.1 and 0.2 marked complete; progress 12/80. **wave 1's 1.1 and 1.2 are
unblocked**, as are 2.5, 2.6, 3.8, 3.10 and 3.11 when their waves come. write them against arm B: an RTP
track rendered into a `<video>` element, playout-delay `min=0, max ∈ (0, 500]`.

the LAN row (host here, client a macOS box on the same switch, n=150 each):

| arm | `_rv` p50 | `_rv` p95 |
| --- | --- | --- |
| **B** rtp track → `<video>` | **31.17** | **32.18** (sd 0.58) |
| A datachannel → webcodecs | 20.15 | **1067.58** |

arm A fails both clauses of the amended rule and the original p50-only rule too. arm C was already out. the
§2 amendment turned out not to change the outcome — it changed which arm *looked* like winning on
same-machine data, and the LAN row corrected that on its own.

**two same-machine conclusions were wrong, in opposite directions** (memo §14.3). arm B's 30–82 ms p95 was
host and client contending for one CPU, not chrome's render scheduling — on the LAN it is 32.18 ms p95 with
sd 0.58, so the p95 follow-up work scheduled against arm B is not needed. and arm A's "predicted blocker did
not materialise" was an artifact of loopback having no loss: review-1 F1 was right about the mechanism and
wrong only about the symptom. measured `net+jitter` p95 1023 ms sits within noise of `sctp-proto`'s
`RTO_MIN = 1000 ms`. stated as a hypothesis with its evidence — not confirmed by re-running arm A patched,
and it would not change the decision since patch 3 floors RTO at 400 ms.

the lesson worth keeping: **same-machine rows misled in both directions and the single LAN run caught both.**
0.1 §2.2's "ranking only" label was not pedantry.

**still open, none of it blocking:** the impaired matrix (§10) is now product validation against arm B alone,
not a gate — clumsy 0.3 cannot express the 10 ms jitter term at all, so it will run as 2% loss + 40 ms RTT
with that cell unproduced. every photon number. the ≥120 Hz row (the macOS client is 60 Hz too). goodput at
1/2% loss, single-frame-loss recovery, HEVC on the LAN.

**the largest open risk is now in the transport layer, not the video path**: str0m's pacer is unusable as
configured (BWE on → 1015.6 ms p50 of pacer queue, GoogCC settling at 8.9 Mbps, with zero loss/PLI/NACK in
getStats so nothing standard reveals it). arm B uses str0m too, so this lands on tasks 1.2, 3.8 and 4.7
regardless. memo §13.4 carries the rest.

### 2026-09-18 — **wave 1 complete.** 14/80.

1.1 and 1.2 ran in parallel once G1 closed. gates verified here, not taken from the reports: `cargo clippy
-- -D warnings` clean, `cargo test` 5 passed, `cargo build --release --locked` clean — all with cwd
`agent/swoop`, which also proves the nested spike manifests do not break the product build. `version` prints
3.3.5 matching `agent/VERSION`, `probe` emits json, `sync-versions.js` lists the crate, and the manifest has
exactly one `^version = ` line so its first-match rewrite is safe. 39 golden vectors, 13 reject, 0 missing,
0 lacking expect/reason. no real key material in `testdata/`; the two ed25519 seeds are the printable strings
`swoop-golden-vector-test-key-001/-002`, real keypairs on purpose so signature verification can be exercised.
`PROTOCOL.md` greps clean of install-tree material — 0.5's held content did not travel into the public spec.

**decisions taken where the plan was silent** (1.1): lease renewal rides `swoop-control` as a fresh viewer
jwt, verified with the §11 order plus "`fp` must equal the live dtls fingerprint" — no new route, one
verification path; a missed renewal drops that viewer at exp+30s, not the session. bundle `ctl` is a session
floor, not a grant. **five data channels, not six** — clipboard rides control, because str0m caps buffering
at 128 KiB *across all channels*, so fewer channels is one pacing budget rather than five competing ones
(same constant that made the 2 MB patch backfire in 0.2 §6). `K_session` **is** in the bundle: the streamer
holds no long-lived credential and cannot derive it, so it arrives per-session over the agent's
authenticated channel and is zeroized — 0.5's "never stored" is scoped to viewers, and §7 says so explicitly
so nobody reads it as a violation. `streamerEpoch` is unix microseconds and the three frame timestamps are µs
relative to it, so the browser never needs the host's QPC frequency.

**corrections to the plan's own text**:
- the jwt verification order in 1.1's brief ("signature → `kid` → …") **is not implementable** — the key
  cannot be selected before `kid` is read. 0.5's order is used and §8 says why.
- `fp_mismatch` cannot be a static golden vector; it is a comparison against a live offer's
  `a=fingerprint:`. reassigned to task 2.10's unit test rather than dropped.
- under arm B the binary frame header carries **no video** — it is a header-only record
  (`payloadBytes = 0`) on a `swoop-meta` channel, joined to the rtp track by `rtpTimestamp90k`. fragment
  index/count are retained for the deferred second video path and labelled as such.
- **"only 1.2 and 10.1 edit the manifest" cannot fully hold.** no crate is pinned behind `encode-ffmpeg`,
  `encode-vpl`, `encode-amf`, `encode-openh264` or `audio-opus`, because spike 6.7 and task 7.2 pick those
  backends by hardware measurement and none is chosen yet — pinning one now would pin a dependency nothing
  has established is used, which the global prefs forbid. the feature *names* exist; the task that picks a
  backend adds its optional dep to the matching line. **amend 6.7 / 7.1 / 7.2's standing rules.**
- the crate has a `[lib]` as well as the `[[bin]]`: task 2.10's `tests/protocol_vectors.rs` is an
  integration test and cannot reach a bin-only crate.
- `#[cfg(windows)]` gating is **by backend, not by module name** — traits and wire types stay portable so
  wave 9 fills them in place. verified: the graph resolves for `x86_64-unknown-linux-gnu`.

msrv 1.91.0, verified both directions (`+1.91.0` checks, `+1.90.0` refused by `moq-nvenc`). release binary
320,512 bytes, versioninfo stamped, no `VCRUNTIME140` reference so `+crt-static` took. str0m's unusable
pacer is noted beside its pin and is why `transport/pacer.rs` exists; it lands on 3.8 and 4.7.

**next**: wave 2 (agent integration, server libraries, CI). no gate in the way.
