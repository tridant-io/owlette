# Adversarial review — swoop plan-draft.md, media pipeline / latency / library choices

Reviewer brief: principal engineer, low-latency streaming. Date 2026-09-17.
Scope: T3 (video path), T4 (str0m), loss recovery, host pipeline, §5 budget, §7 criteria,
multi-viewer, day-one gaps. Ranked by impact on the owner's goal (lowest latency, works everywhere).

Everything below cites either a file/line I read at HEAD today or a document in `swoop-research/`.
Where I am inferring, I say so.

---

## F1 — CRITICAL. str0m's SCTP sender is not, today, a 20–50 Mbps video transport. The numbers are in the source, not merely "unmeasured".

**The plan's claim.** T3 makes encoded-frames-over-DataChannel the **primary** video path.
T4 lists the SCTP ceiling as an *unknown* ("unknown SCTP sender throughput ceiling"), and §8 risk 1
repeats it. Spike 0.2 is then asked to prove "50 Mbps sustained 60 s without send-buffer growth".

**Why this is wrong.** It is not unknown. I read str0m and sctp-proto at HEAD and the constants are
hostile to this workload, in four independent ways:

| | Chrome dcSCTP (`dcsctp_options.h`, in `swoop-research/raw/`) | str0m + sctp-proto (HEAD, 2026-09-17) |
|---|---|---|
| App-level send-buffer cap | `max_send_buffer_size = 2_000_000` + per-stream limit | **`MAX_BUFFERED_ACROSS_STREAMS = 128 * 1024`** — *all streams combined* (`str0m/src/sctp/mod.rs:30`) |
| Initial cwnd | `cwnd_mtus_initial = 10` (~11.9 KB) | `(4*mtu).min((2*mtu).max(4380))` = **4380 B** (`sctp-proto/src/association/mod.rs:438`) |
| cwnd floor on loss | `cwnd_mtus_min = 4` | **`self.cwnd = self.mtu`** = 1228 B on every RTO (`association/mod.rs:4238`) |
| RTO min / initial | **400 ms / 500 ms** | **`RTO_MIN = 1000`, `RTO_INITIAL = 3000`** (`sctp-proto/src/config.rs`) |
| Burst limiter | `max_burst = 4` | none present |
| Path MTU discovery | — | none; fixed `INITIAL_MTU = 1228`, str0m uses `max_payload_size = 1200` |

Two consequences that break the plan as written:

1. **`Channel::write()` silently refuses whole frames.** `str0m/src/channel.rs:58-62`:
   ```rust
   pub fn write(&mut self, binary: bool, buf: &[u8]) -> Result<bool, RtcError> {
       let available = self.rtc.sctp.available();     // 128 KiB minus ALL streams' buffered_amount
       if buf.len() > available { return Ok(false); }
   ```
   A 1080p IDR at 20 Mbps is routinely 200–400 KB. A 4K60 P-frame at 40–50 Mbps is 83–104 KB, so two
   frames in flight already exceed the cap. `Ok(false)` is not an error — a naive sender drops the
   frame and never knows why. The plan's own §5 4K60 case and §7 "4K" quality mode are *below* the
   library's ceiling before any network is involved.
2. **The pass criterion is unmeasurable as phrased.** "50 Mbps sustained without send-buffer growth"
   cannot fail the way it is written, because the buffer is hard-capped at 128 KiB. The failure mode
   is *write refusal and frame drop*, not growth.

Also note this cap is **shared with the control channel**. A pasted 200 KB PNG on the clipboard
channel starves the video channel until it drains. T10's "clipboard size caps on the host" needs a
number derived from this constant, not a round guess.

**Concrete change.**
- **Demote T3.** State it as "candidate A, to be selected by spike 0.2", not "primary". The decision
  rule in the spike must be written *before* the spike, and must name the fallback.
- Rewrite the 0.2 video-transport criteria to: (a) `Channel::write()` returning `Ok(false)` **zero
  times** in a 60 s 50 Mbps run; (b) p99 write→wire for a 300 KB IDR; (c) measured goodput ceiling of
  the str0m sender to Chrome at 0%, 1%, 2% loss / 40 ms RTT, reported as a number.
- Add an explicit remediation branch to the spike with a cost estimate for each: patch
  `MAX_BUFFERED_ACROSS_STREAMS` in a fork; upstream a configurable cap + `max_burst` + IW10 +
  `rto_min` to str0m (this is a small, well-defined PR and worth offering upstream); or fall back to
  the media-track path / LiveKit libwebrtc.
- Add `rto_min`, initial cwnd and burst as *tunables we intend to change*, and say so in T4's gap
  list rather than describing the ceiling as unknown.

---

## F2 — CRITICAL. `{unordered, maxRetransmits: 0}` on the video channel is the wrong reliability mode, and the plan's own flagship precedent uses the opposite.

**The plan's claim.** §3 architecture: "video (unordered, unreliable)". T3's evidence line leans on
moonlight-web as the measured precedent.

**Why this is wrong.**

*(a) The arithmetic.* SCTP reassembly is all-or-nothing per message. A 200 KB access unit is ~170
DATA chunks at a 1200 B payload. With `maxRetransmits: 0`, P(frame survives) at 1% loss is
0.99^170 ≈ **18%**. At 2% it is ≈ 3%. Chunking to 16 KiB messages does not help — the *frame* is
still the unit you need, and 13 messages × 87% each is the same answer. So at the loss rates the
brief names (lossy Wi-Fi, 1–2%), an unreliable video channel does not deliver keyframes.

*(b) The congestion controller does not forgive you.* `maxRetransmits: 0` abandons the chunk via
FORWARD-TSN, but the loss event still runs: 3 missing indications → `self.cwnd = self.ssthresh`
(halved, `association/mod.rs:3195-3196`); a tail loss (the common case for a bursty 60 fps sender —
the last packets of a frame have nothing behind them to generate duplicate SACKs) gets **no** fast
retransmit and goes to RTO → `cwnd = 1 MTU` after **≥1000 ms**. That is ~60 dropped frames and a
slow-start climb, per event. You get frame loss *and* the congestion penalty.

*(c) The precedent does the opposite, deliberately.* `swoop-research/raw/mw_transports.md`:
> the video DC is **ordered** with `maxPacketLifeTime=500 ms` (a lifetime, not a retransmit count:
> a link freeze must not replay second-old frames ahead of the keyframe); the frontend detects
> `frameId` gaps and requests an IDR rather than reordering (a frontend reorder buffer was tried and
> removed — it causes IDR floods and latency).

moonlight-web also runs a **256 KB DC high-watermark with keyframes exempt** — i.e. the one shipping
implementation with published numbers hit exactly the buffer problem in F1 and solved it with an
explicit exemption. str0m gives you no exemption; `available()` is absolute.

**Concrete change.**
- Change the default to **ordered + `maxPacketLifeTime` ≈ 2–3 frame intervals** (33–50 ms at 60 fps,
  not moonlight-web's 500 ms — their host is behind a GameStream hop, ours is not). This gets you
  one intra-deadline retransmit on a LAN/short-RTT path for free and abandons cleanly on a long one.
- Fragment at the SCTP payload size (~1200 B), not one message per frame and not 16 KiB. A 256 KiB
  message is legal on the wire (Chrome advertises `max-message-size: 262144`; str0m's
  `LOCAL_MAX_MESSAGE_SIZE` is the same) but it is the worst possible unit for partial reliability and
  for the 128 KiB buffer.
- Put the **reliability mode itself** in the spike 0.2 matrix — `{ordered, lifetime}` vs
  `{unordered, retransmits: 0}` vs `{unordered, lifetime}` — measured at 0/1/2% loss. This is a
  one-line config change per arm and it is the single highest-information experiment in the wave.

---

## F3 — HIGH. §7's success criteria contradict §5's own budget, and the citation under them is misread in three ways.

**The plan's claim.** §5: "Fixed non-network cost ≈ 45–55 ms". §7: "LAN, Chrome fullscreen, 1080p60,
NVENC: input-to-photon p50 ≤ 35 ms". Wave 0.2 gate: "path A LAN click-to-photon p50 ≤ 35 ms".
T3's supporting evidence: "moonlight-web (Sept 2026) measures 26.8–30.3 ms LAN click-to-photon".

**Why this is wrong.** 35 ms is below the plan's own stated floor of 45 ms, in the same document.
And the 26.8–30.3 figure will not carry the weight put on it. From
`swoop-research/raw/mw_ch15.md` §15.1 and `mw_bench.md` §6c:

- **Not LAN.** "the client, **on the same machine**, samples the presented pixels of the stream".
  Zero network, zero ICE, zero SCTP-over-a-real-path. The transport in that run is a loopback.
- **Not photon.** The probe "runs on `requestAnimationFrame`", and "a canvas presented with
  `desynchronized: true` **reads back empty through `drawImage`, so the probe asks the renderer for
  its pixels instead (`probePixels`)**". Reading the renderer's own buffer is before the compositor
  hands off and long before scanout. The ~16.7 ms compositor + ~8 ms scanout in the plan's own §5
  row 12/13 are not in that number.
- **Not the plan's configuration.** 720p stream upscaled ×2, **165 fps into a 165 Hz panel**,
  n = **10 clicks**, and the chapter says "the dispersion of a fullscreen series is 20–40 ms on ten
  clicks, so this is a trend to confirm on real game content, not a verdict". The same repo's §6c
  fullscreen run at 60 Hz gives a **median of 34.5 ms with a bimodal 25–38 / 55–70 distribution**,
  and attributes the bimodality to 60 Hz capture quantisation.
- The source states the constraint outright: "treat them as **ranking within a series, never as
  absolute latencies of the product**."

A gate that cannot be met will kill path A (and str0m) for a reason that has nothing to do with
either. That is the worst possible outcome of a bake-off.

Minor related accuracy point: the plan annotates the `<video>` penalty as "(renderer-only
comparison)". It is the opposite — `mw_ch15.md` §15.5 says the renderer-only overlay made `<video>`
look *fastest* (2.6 ms vs 18) and that "it was the wrong conclusion, because the overlay stops
before the compositor". The 35–45 ms came from the click-probe. The plan understates its own
strongest piece of evidence.

**Concrete change.** Replace §7's first bullet and 0.2's gate with a measurement contract plus three
tiers:
- **Define the harness first (task 0.1 already exists — give it a contract).** State explicitly
  whether the client probe reads the renderer's buffer, the composited surface, or a photodiode/
  high-speed camera. Publish the number the harness *cannot* see (compositor + scanout) as a fixed
  additive term so every later number is comparable.
- **Comparable-to-moonlight-web number** (renderer-visible, same-machine, 1080p60): p50 ≤ 35 ms.
  This is the number that validates the *pipeline*.
- **Product number** (real LAN hop, 1080p60, Chrome fullscreen, **60 Hz client**, photon-measured):
  **p50 ≤ 55 ms, p95 ≤ 80 ms.** Add a separate 120 Hz+ row at p50 ≤ 40 ms, since the plan's §5
  already says three of the four fixed stages halve.
- **Make the 0.2 gate relative, not absolute**: path A must beat path B by ≥ 15 ms p50 on the same
  harness at the same settings, and must not lose to it at 2% loss / 40 ms RTT. If A wins on LAN and
  loses badly under impairment, that is the finding — an absolute threshold hides it.

---

## F4 — HIGH. The keyframe-free loss-recovery story is over-sold. It is NVENC-only, it is a full RTT behind, and Chrome now hard-fails a damaged HEVC picture.

**The plan's claim.** T3: "libwebrtc receivers offer no keyframe-free loss recovery ... while our own
framing allows reference invalidation". §3: "loss recovery (reference-frame invalidation or LTR where
the encoder supports it, else IDR with a 250–500 ms cooldown)". §6 wave 4.1: "IDR/RFI policy".

The premise is right — the deep dive establishes that your-own-transport + WebCodecs is the only
publicly documented way to do RFI to a browser at all (`pixelflux` #29, 2026-09-16). But four things
are missing:

1. **The loop is 1 RTT + encoder depth wide.** At RTT 40 ms and 60 fps, by the time the host learns
   frame *N* was lost it has already emitted *N+1..N+3* referencing it. Recovery costs ~1 RTT + the
   LTR-based frame ≈ 55–70 ms — barely better than an IDR, and an IDR is *simpler*. The measurable
   win of RFI over IDR is the **bitrate spike avoided**, not the latency. Say that.
2. **The DPB runs out.** `moonlight-common-c` PR #122 (merged 2026-01-21) **replaced** RFI with
   LTR + client ACKs precisely because "all non-invalidated frames are pushed out of the DPB before
   the RFI lands" on long-RTT links; Sunshine's `nvenc_base::invalidate_ref_frames()` falls back to
   IDR when the request spans ≥ DPB size. moonlight-web runs `kDpbFrames = 4` with `numRefL0 = 1`,
   which heals up to three consecutive lost frames and no more.
3. **AMF has no reference-invalidation API at all** (deep-dive §4.6, AMF encode API doc), and MF's
   LTR is an *optional* ICodecAPI property (F5). So "RFI where supported" means NVENC only, i.e. the
   fleet's Intel/AMD/no-GPU machines get IDR regardless. Plan for that as the default, not the
   fallback.
4. **A damaged picture is now a decoder error, not a smear.** Chromium CL 8160680 (merged 2026-07-28,
   in every current stable, M150–M153) "Reject HEVC non-first slice segment when prior slice is
   missing" — a driver OOB-write fix. Multi-slice/multi-tile senders now get a **hard decode
   failure**. In WebCodecs that means the `VideoDecoder` errors and needs `configure()` + a key chunk
   — an IDR anyway, plus a reconfigure. *(Inference: this lives in `media/gpu/`, shared with
   WebCodecs; confirm in the spike.)* This directly constrains T7's "slice/intra-refresh choices",
   because NVENC intra-refresh is **slice-based** and therefore makes every frame multi-slice.

**Concrete change.**
- Make **IDR + 250–500 ms coalesced cooldown + exponential backoff the shipped v1 recovery**, for
  every encoder. This is what moonlight-web ships and what its notes say is hard-won.
- Re-scope RFI/LTR to a **measured NVENC-only experiment** inside the Wave 5 encoder-breadth spike,
  with a stated success bar: "reduces keyframes/minute at 1% loss by ≥ 5× with no increase in decoder
  errors" (pixelflux's own numbers: 286 drops / 49 keyframes without RFI vs 266 / 0 with).
- Add a hard protocol rule to `PROTOCOL.md` (task 1.1): **the client never submits a chunk whose
  references it did not receive**; on a gap it drops to the next recovery point. Add a golden-vector
  test for it.
- Default to **single-slice** frames; make intra-refresh opt-in behind the same spike, and note that
  it makes loss strictly more expensive on a browser receiver.

---

## F5 — HIGH. "Media Foundation hardware MFT as the universal Intel/AMD backend" is asserted, and the plan's own research says the opposite.

**The plan's claim.** T7: "Then **Media Foundation hardware MFT** as the universal Intel/AMD (and
NVIDIA-fallback) backend — in-box, zero licence/packaging cost, `CODECAPI_AVLowLatencyMode`, **LTR
control**. Native AMF / oneVPL only if spike measurements show the MF path is materially slower."

**Why this is risky.**
- `swoop-research/03-windows-host-stack.md` §2.1 says the opposite in as many words: "Vendor SDK
  direct is the only way to get all the low-latency knobs... FFmpeg exposes a *subset*; **Media
  Foundation exposes even less and adds a COM/MFT pipeline you do not control**." The plan inverted
  its own research's conclusion without new evidence.
- **LTR is not guaranteed.** `CODECAPI_AVEncVideoLTRBufferControl` exists, but it is an optional
  ICodecAPI property discovered at runtime via `CODECAPI_AVEncVideoSupportedControls`. Stating "LTR
  control" as a property of the MF backend is a claim about every Intel and AMD driver in the fleet
  that nobody has checked.
- **No precedent in this space uses it as the primary path.** Sunshine ships its own NVENC plus
  FFmpeg `*_amf` / `*_qsv`. OBS *deprecated and removed* its MF-based encoders in favour of AMF and
  NVENC (the AMF plugin was merged because "the older MFT based approach was replaced and performs
  much better"; contemporaneous reports name huge CPU cost on the MF path). The one datapoint on the
  other side is `1ax/rcdesk`, an alpha project.
- **BGRA input.** Research §2.3/§2.4 already establishes that AMF and oneVPL need a conversion stage;
  MF hardware encoder MFTs are NV12-in. So the "convert 0–1 ms" row in §5 is an NVIDIA-only number —
  on Intel/AMD, and especially for the Mosaic/giant-canvas case, there is a mandatory shader or
  `VideoProcessorBlt` pass that the budget does not carry. AMF's documented 4096×4096 frame cap also
  makes a wide canvas impossible on AMD without tiling; the plan's §7 "giant spanned canvases" bullet
  does not acknowledge that.

**Concrete change.**
- Reword T7 to: "**FFmpeg `hevc_amf`/`h264_amf` and `hevc_qsv`/`h264_qsv` (Sunshine's path) as the
  Intel/AMD backend**; native AMF/oneVPL where a measured knob is missing; MF hardware MFT only as a
  last-resort probe-time fallback." If the licence/packaging cost of FFmpeg's LGPL build is the real
  objection, say *that* is the reason and price it, rather than asserting MF parity.
- Move the decision behind the Wave 5 encoder-breadth spike and give it explicit measurement items:
  per-frame encode latency and p99 on each of MF-MFT / FFmpeg-wrapper / native SDK on one Intel and
  one AMD part; whether `CODECAPI_AVEncVideoSupportedControls` advertises LTR on each; whether a
  D3D11 BGRA texture is accepted; the cost of the conversion pass at 1080p, 4K and one Mosaic-sized
  canvas.
- Add a §5 budget row for **convert on non-NVIDIA**, and an explicit "AMD 4096 px axis cap →
  tiled encode" line to the displays task (5.4).

---

## F6 — MEDIUM-HIGH. Two encoder tiers is exactly consumed by the codec split, so §7's own multi-viewer criterion breaks T5's promise. And nothing governs the host's aggregate uplink.

**The plan's claim.** T5: "up to two concurrent encoder tiers (codec tier and/or bitrate tier) ...
never Parsec's 'one client downgrades everyone'." §7: "Three viewers with mixed codecs on one
machine."

**Why this breaks.**
- Mixed codecs already costs both tiers (one HEVC for the Chrome/Safari viewers, one H.264 for the
  Edge/Firefox viewer — research 05 §0 spells this out). With both tiers spent on codec, **any two
  viewers on the same tier share one bitrate, and the slower one sets it.** That *is* Parsec's
  behaviour. The plan's success criterion and its promise cannot both hold at three mixed viewers.
- The "two" is also arbitrary given the plan's own evidence: NVIDIA's support matrix lists **12
  concurrent NVENC sessions** on consumer GeForce. The real constraint is GPU headroom on a saturated
  TouchDesigner box (§8 risk 3), not a session count.
- **There is no aggregate uplink governor anywhere in the plan.** N viewers get N independent GCC
  loops (str0m runs N independent `Rtc` state machines), which on a shared host uplink is N
  controllers each probing for the full capacity of the same bottleneck. They will oscillate and
  collectively bufferbloat the kiosk's own DSL line. Parsec's crude "30 Mbps ÷ 5 guests" at least
  bounds it. This is a day-one correctness issue for a fleet product, not a nicety.
- Second-order: a new viewer joining forces an IDR every existing viewer eats (Unreal's documented
  cost #2), and the plan's coalescing rate-limit is specified for PLI but not for join.

**Concrete change.**
- Replace "at most two tiers" with "**tiers = min(codec classes required, encoder budget)**, where
  the encoder budget is measured per machine at probe time from GPU headroom and recorded in
  `capabilities.swoop`". Three viewers with mixed codecs should be able to get 3 encodes on an
  RTX 2080 Ti and 1 on a 4-core VM.
- Add an explicit **host aggregate uplink budget**: one shared estimate (seeded from the highest
  per-peer GCC estimate when there is one relayed/direct path in common, or a configured cap), then
  a documented allocation policy across viewers (proportional-fair with a floor, say). Name the
  arbitration rule in T5 so the per-viewer governors cannot pull one encoder in opposite directions.
- Add "**new-viewer IDR is coalesced into the existing cooldown window**" to the fan-out task (6.4),
  and a criterion: a viewer joining a 3-viewer session causes at most one IDR.

---

## F7 — MEDIUM. Frame pacing and presentation scheduling are absent from the plan entirely.

The plan has a host-side pacer ("per-viewer sender (pacing + app-level rate governor)"), and it has a
capture story. It says nothing about the client side of pacing: when a decoded `VideoFrame` is drawn,
what surface, and what happens at 60 fps into a 60 / 120 / 144 Hz client. There is no task, no
decision, and no success criterion for it.

This is not theoretical. `part5-lessons.md` §5.2 establishes that Parsec's own web client draws in
`requestAnimationFrame` and gives away up to 16.7 ms for nothing; §9.2 of the browser research
establishes that rAF **does not fire in a hidden tab**, so an rAF-driven present stalls a backgrounded
window; and moonlight-web ships its pacer **opt-in**, hard-caps the reserve at 25 ms, and documents a
shipped bug where the reserve pinned at 24.6 ms against a 2.9 ms measured tail. A 60 fps stream
presented naively on a 60 Hz client beats against the vsync: some vsyncs show two frames (one
dropped), some show none. That is visible judder and it is the single most common "it feels worse
than Parsec" complaint in this product category.

Two facts the plan also has slightly wrong here, both in the same sentence of T3:
- "**DataChannel callbacks arrive on the main thread in Chrome (transferable DC is behind a flag)**"
  — out of date. Transferable `RTCDataChannel` to dedicated workers **shipped in Chrome 130**, and
  WebKit had already shipped it (blink-dev Intent to Implement & Ship; MDN: "`RTCDataChannel` is a
  transferable object"). Gecko is "no signal". So the main-thread constraint is a **Firefox**
  constraint, not a Chrome one — and Firefox is also the engine with no `desynchronized` canvas.
  Reframe as "Firefox is the structurally degraded client" and set expectations in the UI.
- `desynchronized` is Chromium-only and can tear; moonlight-web's own probe found a `desynchronized`
  canvas "reads back empty through `drawImage`". That is a live constraint on the telemetry design,
  not just the render path.

**Concrete change.**
- Add a **presentation contract** to T3 (and a task under 3.13): decode in a worker; present from the
  `VideoDecoder` output callback, not rAF; `desynchronized: true` where available with an
  `ImageBitmapRenderingContext` fallback; use `rVFC`'s `presentedFrames`/`expectedDisplayTime` to
  *measure* drops, never to schedule; `frame.close()` immediately.
- Add a judder criterion to §7: over a 60 s 1080p60 run on a 60 Hz client, dropped + duplicated
  presented frames ≤ 2%, and no run of ≥ 3 consecutive duplicate presents.
- Add a background/occluded-window criterion: a stream in a non-visible tab keeps decoding and
  recovers within one frame of becoming visible (this is why the decode loop belongs in a worker).
- Add "measure `decodeQueueSize` and submit→output per frame; alarm above 1.5 frame intervals"
  (Parsec computes exactly this EWMA; `optimizeForLatency` is a hint that WebView2 #4099 and
  w3c/webcodecs #732 both show is not reliably honoured).

---

## Also worth fixing (short, lower impact)

- **Mid-session resolution / topology change is not mentioned anywhere.** A TouchDesigner box going
  fullscreen, a projector waking, a Mosaic reconfigure — all change the stream's SPS. Chromium CLs
  7644891 (M148) and 8176990 (M153) make *any* non-IRAP H.265 SPS change a **hard decode failure**,
  and WebCodecs needs a `configure()` + key chunk. Add an explicit "resolution change = new
  configure + IDR, coordinated over the control channel" item to the protocol spec (1.1) and the
  displays task (5.4).
- **No path-MTU story.** sctp-proto has no PMTUD and fixes `INITIAL_MTU = 1228` (str0m uses a 1200 B
  payload). Over TURN-over-TLS:443 the effective path shrinks (TURN ChannelData + TLS record + TCP).
  Add an MTU item to spike 0.6, not just throughput.
- **Edge WebCodecs HEVC probably needs the paid HEVC Video Extensions package.** Chrome uses
  D3D11VA directly and does not; Edge uses the MediaFoundation path and does. That is the likely
  reason the 1.14M-session dataset shows Edge/Windows at ~56% vs Chrome non-Windows ~81%. Worth a
  line in the capability-probe task (3.13) so the fallback to H.264 is expected, not a bug report.
- **No RTT measurement is named in the client stats.** `part5-lessons.md` §5.7 flags that Parsec's
  own web client reports `networkLatency = 0` and never measures RTT, and says "do not repeat this".
  T12 says "per-stage breakdown" but never names RTT. Add it explicitly — without it you cannot size
  a retransmit deadline (F2) or diagnose a field report.

---

## What I tried to break and could not

These are load-bearing and I could not find a hole in them. They should not be relitigated.

- **T3's playout-delay guidance for the media-track path: `min=0, max ∈ (0, 500] ms`, NOT `max=0`.**
  This is correct against the source and it corrects the folklore (and what JetKVM ships).
  `video/frame_decode_timing.cc` + `video/video_stream_buffer_controller.cc`: `max=0` makes
  `MaxWaitingTime` permanently ≤ −5 ms, so whenever ≥2 temporal units are decodable the older ones
  are dropped via `DropNextDecodableTemporalUnit()` — which on a non-scalable H.26x chain breaks the
  reference chain and triggers a PLI. `min=0, max>0` takes the identical `RenderTime()==0` path.
  The plan got this right and most teams do not.
- **T2's process model.** SYSTEM token retargeted to the console session via
  `DuplicateTokenEx` + `SetTokenInformation(TokenSessionId)`, `CreateProcessAsUser`,
  `lpDesktop=WinSta0\Default`, Job Object `KILL_ON_JOB_CLOSE`, `OpenInputDesktop`/`SetThreadDesktop`
  on a dedicated capture thread, DDA recreated on `DXGI_ERROR_ACCESS_LOST`, `SendSAS` from the
  service. This is exactly Sunshine PR #137 + Looking Glass #263 + TailVNC, and it satisfies the
  repo's never-elevate-unattended guardrail by construction. No UAC path exists in it.
- **T8's signalling and key design.** Browser-always-offerer, EdDSA JWTs verified independently by
  the Worker *and* the streamer, `fp` binding the viewer JWT to the browser's DTLS certificate, and
  `k = HKDF(K_session, viewer id)` MACing the host fingerprint so a compromised relay cannot MITM.
  I could not construct an attack against a relay that sees neither `K_session` nor `k`.
- **The NVENC H.264 VUI fix** (`bitstreamRestrictionFlag=1`, `max_num_reorder_frames=0`). The
  208 ms → 8.3 ms measurement is real and reproduced in moonlight-web's own bench table. Without it a
  naive H.264 implementation is unshippable. Keeping it in T3 as a named landmine is right.
- **H.264 as a first-class path, not a fallback.** Edge has no WebRTC H.265 and no roadmap; Firefox
  never; ~25% of Windows Chrome has no HEVC hardware decode and Chrome ships no software fallback.
  The plan's ladder is correct.
- **T6's "never change display configuration without a per-machine opt-in."** Sunshine #3591
  (alters the refresh rate of displays it is not using) is exactly the failure this prevents, and on
  a signage fleet the display config *is* the product.
- **T12 instrumentation-first, and the per-frame capture/encode/send timestamps.** Right call, and
  the reason F3 is fixable cheaply rather than expensively.
- **Rejecting libdatachannel.** No transport-cc, no BWE, no TURN over TCP/TLS in libjuice, no ICE
  restart, and 27 UAF/crash/corruption issues since 2025-01 with no OSS-Fuzz. For a SYSTEM process
  parsing internet packets this is not close. (Note the irony that moonlight-web — the plan's
  precedent — runs on it, which is *also* why moonlight-web has no congestion control at all.)

## What I could not verify

- **Whether str0m's sctp-proto can sustain 20–50 Mbps to Chrome at all.** I established the
  constants; I did not find a published measurement of the sender in either direction. This is
  genuinely open and is the single most valuable number in spike 0.2.
- Whether Chromium CL 8160680's "reject non-first slice segment when prior slice is missing" applies
  to the **WebCodecs** decode path as well as the WebRTC one. It is in `media/gpu/`, which is shared;
  I did not trace the WebCodecs call path.
- Whether a Chrome/D3D11 or VideoToolbox WebCodecs decoder with `optimizeForLatency: true` reliably
  keeps a 4-deep DPB so an LTR several frames back is still resident. w3c/webcodecs #743 (open since
  2023-11) asks for explicit LTR control precisely because there is no way to assert this from JS.
- Whether current Intel and AMD MF hardware encoder MFTs advertise
  `CODECAPI_AVEncVideoLTRBufferControl` in `CODECAPI_AVEncVideoSupportedControls`. The property is
  documented; per-vendor support is not.
- The Cloudflare TURN billing asymmetry in T9 and the per-allocation shaping band. The plan already
  flags this for validation, which is the right posture.
- Whether Chrome's *server-side* Finch still sets `WebRTC-ZeroPlayoutDelay/min_pacing:0ms`. Only
  relevant to path B, and only to the `min=0, max>0` arm; WebRTC deleted the trial upstream on
  2026-08-13 and promoted 8 ms to a constant, so it is a real behaviour change coming to path B.
