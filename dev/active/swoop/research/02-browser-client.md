# Swoop — Browser Client Research (as of 2026-09-17)

Scope: what a browser can actually do, in September 2026, as the *receiving* client of a
Parsec-class low-latency desktop stream from a native Windows host. Every claim is tagged
`[V]` (verified against a cited source) or `[I]` (inference / engineering judgement built on
cited facts). Source URLs and their publication/update dates are inline and collected at the end.

---

## 0. Executive matrix

| Capability | Chrome/Edge (desktop) | Safari (macOS) | Firefox (desktop) | Notes |
|---|---|---|---|---|
| WebRTC H.265 receive | **Chrome 136+ default** `[V]` | **Safari 18.0+ default** `[V]` | **No, and no plan** `[V]` | HW decode required; no SW fallback `[V]` |
| WebRTC H.265 in **Edge** | **Unverified — Edge does not *send*** `[V]`; receive unknown `[I]` | — | — | Treat Edge as H.264 until measured |
| WebRTC H.264 receive | Yes | Yes | Yes | Universal floor (~99.94% of devices decode H.264) `[V]` |
| WebRTC AV1 receive | Yes (~91% HW/SW) `[V]` | ~24% of macOS sessions `[V]` | Yes `[V]` | Bad Safari story |
| WebCodecs `VideoDecoder` | Chrome 94+, HEVC 8-bit 107+, 10-bit 108+ `[V]` | 16.4+ (video only), full incl. audio in 26.0 `[V]` | 130+ desktop only `[V]` | Android Firefox: undefined `[V]` |
| WebCodecs HEVC decode (real-world) | Chrome non-Windows ~81%, Edge/Win ~56% `[V]` | ~universal on Apple HW `[V]` | <2% `[V]` | 1.14M-session dataset, Mar 2026 `[V]` |
| WebGPU `importExternalTexture` | Yes | Yes | Yes | Fastest present path `[V]` |
| `desynchronized` canvas | Yes (2d/webgl/webgl2) `[V]` | No `[V]` | No `[V]` | Chromium-only since 2019 `[V]` |
| Pointer Lock | Yes | macOS 10.1+; **no iOS/iPadOS** `[V]` | Yes | |
| `unadjustedMovement` (raw mouse) | Chromium 81+ `[V]` | Safari 18.4+ `[V]` | Firefox 152+ (Win/macOS only) `[V]` | Linux/Android reject `NotSupportedError` `[V]` |
| **Keyboard Lock** | Chrome 68+ / Edge 79+ `[V]` | **No** `[V]` | **No** (bug 700123 open; not a 2026 interop priority) `[V]` | Fullscreen + transient activation required `[V]` |
| `getCoalescedEvents` / `pointerrawupdate` | Yes `[V]` | **No** (caps ~1000 Hz) `[V]` | `getCoalescedEvents` yes `[V]` | |
| Async Clipboard write (text/png/html) | Yes | Yes, user-gesture-gated `[V]` | 126+ `[V]` | |
| Async Clipboard **read** | Yes (`clipboard-read` permission) `[V]` | Gesture only, no permission API `[V]` | 147+ via ephemeral paste prompt `[V]` | No clipboard-change event anywhere `[V]` |
| Web custom clipboard formats (`web …`) | Chrome 104+ `[V]` | No `[V]` | No `[V]` | |
| File System Access (`showSaveFilePicker`) | Chrome/Edge 86+ `[V]` | No (OPFS only) `[V]` | No (OPFS only) `[V]` | |
| Window Management (`getScreenDetails`) | Chrome 104+ `[V]` | No `[V]` | No `[V]` | Permission-gated `[V]` |
| `RTCRtpScriptTransform` (encoded transform) | Yes `[V]` | Yes (first, 2022) `[V]` | Yes (2023) `[V]` | Baseline since Oct 2025 `[V]` |
| WebTransport | Yes | 26.4+ (Mar 2026) `[V]` | Yes `[V]` | **Client-server only; no P2P** `[V]` |

---

## 1. WebRTC H.265/HEVC

### 1.1 Chrome / Edge

- **Chrome 136 shipped H.265 in WebRTC enabled-by-default** on all six Blink platforms
  (desktop, Android, WebView). Chrome Platform Status feature 5153479456456704 — created
  2025-02-28, last updated 2025-08-22 — records "Enabled by default (Milestone 136)". `[V]`
  <https://chromestatus.com/feature/5153479456456704>
- Previously gated behind `--enable-features=WebRtcAllowH265Send,WebRtcAllowH265Receive`. `[V]`
- The blink-dev Intent to Ship is explicit: **"H265 encoding is only available if the user's
  device and operating system provide the necessary capabilities as we will not provide a
  software implementation to fall back to."** The same is true of decode. `[V]`
  <https://groups.google.com/a/chromium.org/g/blink-dev/c/3h8lL8a377c>
- The Intent quotes platform HW-support rates: Windows 75%, macOS 99%, Android 86%, iOS 90%. `[V]`
- The Intent names **MediaCapabilities with content type `video/H265`** as the runtime
  detection route, and says the codec is exposed through the ordinary SDP/`setCodecPreferences`
  machinery — no new API surface. `[V]`
- Platform mechanics (StaZhu's canonical Chromium-HEVC guide): HW HEVC decode default since
  **Chrome 107** — Windows 8+ via `D3D11VideoDecoder`/D3D11VA (**Chrome does NOT need the
  Microsoft "HEVC Video Extensions" purchase, unlike Edge**), macOS Big Sur+ via VideoToolbox,
  Linux **only on VAAPI-capable GPUs** (Chrome 108+), Android 5.0+, ChromeOS VAAPI. WebRTC HEVC
  default from **136.0.7077.0**. `[V]`
  <https://github.com/StaZhu/enable-chromium-hevc-hardware-decoding>
- Independent confirmation of the OS split: Chrome v136+ "Windows and macOS work without
  additional configuration; **Linux requires VAAPI**". `[V]` <https://vdo.ninja/h265>

**Edge is the open question.** MSEdgeExplainers issue #1314 (opened 2026-05-05) reports
"Microsoft Edge does not publish H.265/HEVC video codec in WebRTC streams" while Chrome does;
there is no official Microsoft response, target version or milestone in the issue. `[V]`
<https://github.com/MicrosoftEdge/MSEdgeExplainers/issues/1314>
Since Swoop's browser is the *receiver*, Edge's inability to send may not matter — but if Edge
also ships with `WebRtcAllowH265Receive` off, Edge clients silently fall back to H.264. **This
must be measured, not assumed** (run `RTCRtpReceiver.getCapabilities('video')` in current Edge
stable on Windows). `[I]`

### 1.2 Safari

- WebKit added the **WebRTC HEVC RFC 7798 RTP payload format in Safari Technology Preview 179**. `[V]`
  <https://webkit.org/blog/14532/release-notes-for-safari-technology-preview-179/>
- It is **enabled in stable from Safari 18.0**; before that it was behind a Feature Flag
  ("WebRTC H265 codec"). `[V]`
  <https://chris.hiszpanski.name/posts/is-webrtc-hevc-supported/> (post 2024-07-07, updated
  through Apr 2025)
- Safari's HEVC decode is VideoToolbox-backed and essentially universal on Apple hardware —
  the 2026 WebCodecs dataset shows HEVC decode support as universal across Safari platforms. `[V]`

### 1.3 Firefox

- **No WebRTC H.265.** Mozilla's standards-position issue #1188 (opened 2025-03-03) is still
  marked "Needs proposed position" with no formal Mozilla statement. `[V]`
  <https://github.com/mozilla/standards-positions/issues/1188>
- Firefox *does* have HEVC decode where hardware exists, but only through MSE/WebCodecs, not
  WebRTC; community testing on Firefox 142 (Aug 2025) confirms WebRTC H265 does not negotiate. `[V]`
  <https://github.com/bluenviron/mediamtx/discussions/4916>
- Empirically Firefox HEVC decode via WebCodecs is **<2%** of sessions. `[V]`
- Practical conclusion: **Firefox = H.264 (or AV1), never HEVC.** `[I]`

### 1.4 Negotiation — SDP / fmtp

Governing spec is **draft-ietf-avtcore-hevc-webrtc** ("H.265 Profile for WebRTC"), Standards
Track, at **-09** with an expiry of 2027-01-21 (so published ~Jul 2026). `[V]`
<https://datatracker.ietf.org/doc/html/draft-ietf-avtcore-hevc-webrtc>

Key rules:

| Parameter | Default | Requirement |
|---|---|---|
| `profile-id` | 1 (Main) | Main Profile **Level 3.1 (`level-id=93`) is mandatory**; Level 4 (`level-id=120`) recommended |
| `tier-flag` | 0 (Main tier) | — |
| `level-id` | **93** (Level 3.1) | "MUST interpret it when receiving" |
| `tx-mode` | **`SRST`** | **MUST support SRST**; MRST/MRMT optional |
| `sprop-vps` / `sprop-sps` / `sprop-pps` / `sprop-sei` | — | **Excluded from WebRTC SDP — parameter sets are in-band only** |

- Offer/answer: on `sendrecv` the offered `level-id` is the max for both directions; the
  answer's level **MUST be ≤ the offer's**. A peer capable of `level-id=X` is implicitly capable
  of any `Y < X` for the same profile. `[V]` (also raised as w3c/webrtc-pc#3020, Nov 2024)
- `tx-mode` MUST be interpreted; an offer with an unsupported tx-mode is treated like an
  unimplemented codec (not answered). `[V]` <https://github.com/aboba/hevc-webrtc/issues/3>
- **Level 3.1 = 1280×720@30 territory.** If your host offers 1080p60 or 1440p, you must offer
  and honour a higher `level-id` (Level 4 = 120, Level 5.1 = 153) or the negotiation is a lie
  about what you will send. `[I]`

**Scalability:** `w3c/webrtc-svc` states "VP8, H.264 and H.265 only support temporal
scalability (e.g. L1T2, L1T3)" and that H.265 permits simulcast only on distinct SSRCs, so the
`S…` modes are unsupported. So no spatial SVC with HEVC. `[V]` <https://w3c.github.io/webrtc-svc/>

### 1.5 Runtime detection

Two complementary routes, both needed:

1. `RTCRtpReceiver.getCapabilities('video')` → look for `mimeType === 'video/H265'` entries and
   inspect their `sdpFmtpLine` for `profile-id` / `level-id` / `tx-mode`. There is one entry per
   supported profile/level/tx-mode combination. `[V]` (MDN `RTCRtpReceiver.getCapabilities`;
   aboba/hevc-webrtc#3 for the per-combination expectation)
2. `navigator.mediaCapabilities.decodingInfo({type: 'webrtc', video: {contentType: 'video/H265', …}})`
   — the route the Chrome Intent names. `[V]`
   **Caveat: Firefox uses the value `"transmission"`, not `"webrtc"`, so the `webrtc` type does
   not work there.** `[V]` <https://developer.mozilla.org/en-US/docs/Web/API/MediaCapabilities/decodingInfo>

`setCodecPreferences()` is available in all three engines but should still be feature-detected. `[V]`
<https://blog.mozilla.org/webrtc/cross-browser-support-for-choosing-webrtc-codecs/>

### 1.6 Known limitations (summary)

- **No software fallback anywhere in Chrome.** A machine without an HEVC hardware decoder simply
  won't offer H.265. `[V]`
- Linux clients need VAAPI; a Linux laptop on an NVIDIA proprietary driver frequently won't
  have it. `[V]`
- Only `tx-mode=SRST` is guaranteed. `[V]`
- Temporal scalability only. `[V]`
- Cross-implementation interop is reported to be patchy ("different H.265 implementations may
  not be cross-compatible … problematic for SFU broadcasting"). `[V]` <https://vdo.ninja/h265>

---

## 2. WebCodecs `VideoDecoder` + presentation

### 2.1 Codec strings and bitstream form

The **W3C HEVC WebCodecs Registration (2026-06-08)**: codec string is `hev1.` or `hvc1.`
followed by four dot-separated fields per ISO/IEC 14496-15:2024 §E.3. The `description` field
decides the bitstream format: `description` present → `hvcC`/"hevc" length-prefixed format;
`description` absent → **Annex B**, with parameter sets carried periodically in-band, which is
the live-streaming shape you want. `[V]`
<https://www.w3.org/TR/webcodecs-hevc-codec-registration/>

**For Swoop: emit Annex B, no `description`, VPS/SPS/PPS repeated before every IDR.** That is
the streaming-native form and removes an out-of-band config dependency. `[I]`

### 2.2 Support

- Chrome: HEVC 8-bit decode from **107.0.5272.0**, 10-bit from **108.0.5343.0**; Main, Main 10,
  Main Still Picture and Range Extensions profiles. HEVC *encode* from **130.0.6703.0**
  (Main only). Windows <130 hard-capped at 1920×1088@30; **131+ removes that cap** (to
  7680×4320@300); macOS arm64 131+ to 8192×4352@120. `[V]` (StaZhu guide)
- Safari: WebCodecs video interfaces from **16.4**; Audio/ImageDecoder only from **26.0**
  (released 2025-09-15). `[V]` <https://webkit.org/blog/17333/webkit-features-in-safari-26-0/>
- Firefox: WebCodecs enabled on **desktop** in 130; Android still has `VideoDecoder` undefined.
  A long-standing bug (1918769) has H.264 decode failing despite `isConfigSupported()` returning
  true. `[V]`
- Empirical support (WebCodecs Fundamentals, **March 2026**, 1,142,586 real sessions /
  363,330,358 codec tests, self-reported via the WebCodecs API):
  H.264 baseline ~99.94% everywhere; HEVC decode ~universal on Safari, ~81% on non-Windows
  Chrome, ~56% Edge/Windows, minimal on Firefox; AV1 decode ~91% Chrome/Edge/Firefox desktop
  but only ~24% Safari macOS and ~33% Safari iOS. Their headline: "AV1 + HEVC covers 99.73% of
  sessions for decode." `[V]`
  <https://webcodecsfundamentals.org/datasets/codec-analysis-2026/>
  (A companion page gives a slightly different cut — Chrome 54–96%, Safari 85–91%, Edge 46–98%,
  Firefox <2% — presumably because it averages over all 84 HEVC codec-string variants. Treat the
  dataset page as authoritative for "can this device decode Main/Main10". `[I]`)

### 2.3 `optimizeForLatency` and queue depth

- `VideoDecoderConfig.optimizeForLatency: boolean` — "minimize the number of EncodedVideoChunks
  that have to be decoded before a VideoFrame is output". `[V]`
  <https://developer.mozilla.org/en-US/docs/Web/API/VideoDecoder/configure>
- It exists precisely because some decoders use frame-threading and buffer for throughput;
  w3c/webcodecs#206 notes that without it a client would have to call `flush()` after every
  `decode()` to guarantee an output. `[V]` <https://github.com/w3c/webcodecs/issues/206>
- **It is a hint and is not reliably honoured.** WebView2 issue #4099 documents frames not
  rendering until `flush()` or until several P-frames have been queued *with*
  `optimizeForLatency: true`; w3c/webcodecs#732 ("What's the best way to ensure 1-in 1-out
  decoding for h264?") is the same complaint. `[V]`
- `hardwareAcceleration: "prefer-hardware" | "prefer-software" | "no-preference"` is also only a
  hint the UA may ignore; always gate on `VideoDecoder.isConfigSupported()`. `[V]`
- Monitor `decodeQueueSize`; a rising value is the early-warning signal that the decoder is the
  bottleneck. `[V]` <https://developer.chrome.com/docs/web-platform/best-practices/webcodecs>
  (updated 2025-01-22)

**Practical mitigation for the "decoder holds frames" hazard:** send an IDR on connect, keep
`optimizeForLatency: true`, and *measure* the chunk-in → frame-out count on each browser/GPU at
startup; if the decoder is holding >1 frame, either accept the extra frame of latency or fall
back to the WebRTC media path. `[I]`

### 2.4 Presenting decoded `VideoFrame`s — latency ranking

`VideoFrame` is a zero-copy smart pointer to a GPU texture; the presentation path decides
whether you pay a readback. `[V]`

Throughput benchmark (WebCodecs Fundamentals, M4 MacBook Pro, 1080p, Firefox/Chrome/Safari) `[V]`:

| Path | Measured fps range | Copies | Notes |
|---|---|---|---|
| Canvas 2D `drawImage` | 70–960 | CPU-path in places | Most portable, worst and most variable |
| `ImageBitmapRenderingContext` (`createImageBitmap` → `transferFromImageBitmap`) | 220–1120 | one GPU→GPU copy, then zero-copy transfer | Big win on Firefox |
| WebGPU `importExternalTexture` | **430–1230** | **true zero-copy** | External textures are transient — re-import every frame |

These are throughput, not latency, but they bound it. `[I]`

Additional presentation facts:

- **`desynchronized: true`** bypasses the ordinary DOM update path and can send the canvas
  buffer straight to the display controller; targeted at sub-50 ms interactive drawing.
  Supported contexts are `'2d'`, `'webgl'`, `'webgl2'` — **not WebGPU**. Chromium-only. Feature
  detect with `ctx.getContextAttributes().desynchronized`. Caveats: possible tearing;
  set `preserveDrawingBuffer: true` on WebGL to avoid flicker; don't put DOM above a translucent
  desynchronized canvas. `[V]` <https://developer.chrome.com/blog/desynchronized> (2019-05-02)
- **OffscreenCanvas in a worker** is the right home for the decode→present loop: frame/chunk
  callbacks fire many times a second and clutter the main thread. `[V]` (Chrome WebCodecs
  best-practices). Note `desynchronized` and OffscreenCanvas-in-worker are separate mechanisms;
  combining them is not documented as supported and needs testing. `[I]`
- **`VideoTrackGenerator` / `MediaStreamTrackGenerator`** (mediacapture-transform) turns a
  stream of `VideoFrame`s back into a `MediaStreamTrack` you can attach to `<video>`. This is
  *lower* latency than canvas pixel copies but re-introduces the `<video>` element's compositor
  scheduling, and support is narrow (Chromium; Firefox has been unbundling the API). `[V]`
  <https://www.w3.org/TR/mediacapture-transform/>,
  <https://blog.mozilla.org/webrtc/unbundling-mediastreamtrackprocessor-and-videotrackgenerator/>
  For Swoop this path buys nothing over direct WebGPU present. `[I]`
- Always call `frame.close()` immediately after upload — otherwise GPU memory balloons and GC
  stalls appear. `[V]`

**Recommendation: WebGPU `importExternalTexture` in a worker with OffscreenCanvas, with an
`ImageBitmapRenderingContext` fallback and Canvas 2D as the last resort.** `[I]`

---

## 3. P2P transports from a browser

### 3.1 WebRTC media (RTP/SRTP)

The only browser transport purpose-built for realtime video. You get, for free: NACK/RTX,
PLI/FIR keyframe requests, transport-wide CC feedback, GCC bandwidth estimation, pacing,
hardware decode wiring, and A/V handling. You give up: exact control of when a frame is
presented (mitigable — see §4), and codec/bitstream freedom.

### 3.2 `RTCDataChannel` (SCTP / dcSCTP)

Chrome's dcSCTP parameters, as reported by an independent transport analysis: MTU 1191 bytes,
initial cwnd 10 MTU (~12 KB), **max burst 4**, +1 MTU per SACK in slow start, **min RTO 400 ms**,
initial RTO 500 ms, delayed ACK up to 200 ms. `[V]`
<https://github.com/Nehanth/swarmllm/issues/34>

- **Congestion control applies to every data channel regardless of reliability or ordering.**
  Unordered + `maxRetransmits: 0` approximates UDP semantics but *not* UDP behaviour — SCTP's
  CC stays in the path. `[V]` <https://web.dev/articles/webrtc-datachannels>
- Observed steady throughput in Chrome: **2.5–6.4 MB/s (~20–51 Mbps)** at 20–30 ms RTT with no
  loss. `[V]` That brackets your 10–50 Mbps target — it works, with no headroom, on a clean
  link. `[I]`
- The 400 ms RTO floor plus the max-burst-4 restart from idle means a stalled channel costs
  ~1.5 RTT per hop to recover and a loss event can cost 400 ms. **For 60 fps video that is 24
  dropped frames.** `[I]`
- **Message size:** >256 KiB and Chromium *closes the data channel* (usrsctp `EMSGSIZE` is
  unhandled). Cross-browser-safe chunk size is **16 KiB**. Large messages cause head-of-line
  blocking across channels without RFC 8260 interleaving. `[V]`
  <https://lgrahl.de/articles/demystifying-webrtc-dc-size-limit.html>
- Read `RTCSctpTransport.maxMessageSize` rather than hardcoding. `[V]`

**Verdict: DataChannel is excellent for input, cursor, clipboard and control. For video it is a
deliberate trade — you get frame-exact presentation control at the cost of building pacing,
bandwidth estimation and loss recovery yourself, on top of a congestion controller designed for
bulk data.** `[I]`

### 3.3 WebTransport

- W3C Candidate Recommendation Snapshot; **Baseline since Safari 26.4 (March 2026)** — works in
  Chromium, Firefox and Safari incl. iOS with no polyfill. `[V]`
  <https://www.w3.org/TR/webtransport/>, <https://www.w3.org/news/2026/w3c-invites-implementations-of-webtransport/>
- **There is no P2P WebTransport in any browser.** The `w3c/p2p-webtransport` spec ("QUIC API
  for Peer-to-peer Connections") is incubation-stage; the WG re-chartered in 2026 merely to
  "consider incubating mechanisms for peer-to-peer capability", and a TPAC 2026 breakout
  (September 2026) was still debating two approaches: bootstrap P2P via the WebRTC handshake, or
  migrate a client-server connection to a peer. `[V]`
  <https://w3c.github.io/p2p-webtransport/>, <https://github.com/w3c/tpac2026-breakouts/issues/15>,
  <https://w3c.github.io/charter-drafts/2026/webtransport-wg-charter.html>

**Verdict: WebTransport is irrelevant to Swoop's P2P requirement today.** It would only be
usable if you relayed every stream through a server, which contradicts the design. Revisit in
12–18 months. `[I]`

### 3.4 Who actually ships DataChannel + WebCodecs video

- **MoonlightWeb** (moonlightweb.top / linckosz/moonlight-web) is the strongest precedent and
  maps almost exactly onto Swoop's shape: browser client to a Sunshine host, **H.264/HEVC/AV1
  hardware-decoded via WebCodecs, rendered in WebGPU, Opus audio in an AudioWorklet with an
  adaptive jitter buffer, transport = WebRTC DataChannels *plus* RTP media tracks with automatic
  WSS fallback**, pointer-lock mouse + keyboard + touch trackpad + gamepad with rumble.
  Claims up to 4K HDR, 240 fps, **"under 20 ms over Wi-Fi"**. `[V]`
  <https://moonlightweb.top/>, <https://github.com/linckosz/moonlight-web>
  (Vendor marketing claim — the 20 ms number is unaudited. `[I]`)
- **Selkies** (Google-originated, now community/LinuxServer.io) is an HTML5 WebRTC remote
  desktop; its browser client runs on Chromium, Firefox and Safari with two-way clipboard
  (text and images) and "low-latency zero-copy video rendering". `[V]` <https://docs.selkies.io/>
- **Parsec's own web client is the cautionary tale**: Chrome-only, "does not have access to
  low-level hardware optimizations or hardware decoding", "uses WebRTC with less control over
  networking, causing issues with low bandwidth connections and increased lag", can't join
  macOS hosts, unsupported on iOS/iPadOS. Support doc updated 2026-07-07. `[V]`
  <https://support.parsec.app/hc/en-us/articles/32381650129300-Use-the-Web-App-browser>

---

## 4. Minimising receiver latency on the WebRTC media path

This is the single highest-leverage section. Default Chrome will cost you ~80–150 ms you don't
have to pay.

### 4.1 The `playout-delay` RTP header extension — do this first

- URI `http://www.webrtc.org/experiments/rtp-hdrext/playout-delay`, SDP name `playout-delay`. `[V]`
- Wire format: 4-bit ID, 4-bit len (=2), then **12-bit min + 12-bit max**, **10 ms granularity**,
  range 0–40,950 ms. Both are "best effort". `[V]`
- The spec's own worked example for granularity: **"0 ms for gaming/remote desktop"**, 100–200 ms
  for interactive streaming, 400 ms for resilient VOD. It says outright: *"For gaming and remote
  desktop scenarios we will want to play the frame as soon as possible"* → **min=max=0**. `[V]`
  <https://webrtc.github.io/webrtc-org/experiments/rtp-hdrext/playout-delay/>
- The sender attaches it only when the values change, using RTCP feedback sequence numbers to
  know the receiver has picked it up. `[V]`
- Reported to work in Chromium and Safari. Firefox tracked it at bug 1585009. `[V]`
- **This is exactly what Stadia did**: "WebRTC extensions provided by Google's team in Sweden
  were used to disable buffering and display things as soon as they arrive". `[V]`
  <https://bloggeek.me/cloud-gaming-virtual-desktops-and-webrtc/>

Because this is a *sender-side* header extension, Swoop's native Windows host controls it — no
browser API required, and it works on browsers that don't expose `jitterBufferTarget`. **Make it
mandatory in the host's RTP stack.** `[I]`

### 4.2 `jitterBufferTarget` / `playoutDelayHint` — use with care

- Spec: `RTCRtpReceiver.jitterBufferTarget`, a `DOMHighResTimeStamp` in **ms**, valid 0–4000,
  `RangeError` outside. It *influences* rather than sets the target; the UA stays within its own
  min/max. `[V]` <https://developer.mozilla.org/en-US/docs/Web/API/RTCRtpReceiver/jitterBufferTarget>
- **Chrome implements the legacy name `playoutDelayHint` (in seconds)**; Firefox implements the
  spec name (bug 1592988); WebKit's standards position is tracked at
  WebKit/standards-positions#317. `[V]`
- **Do not set it to 0.** Selkies' optimisation meta-issue (#157, opened 2024-05-25) warns
  explicitly that forcing `jitterBufferTarget`/`playoutDelayHint` to zero "causes stutter if the
  buffer wants to be bigger, but it's constantly forced down to 0", and that the *playout-delay
  header extension with zero values* is the "MUST implementation" instead. `[V]`
  <https://github.com/selkies-project/selkies/issues/157>
- Measure the result via `RTCInboundRtpStreamStats.jitterBufferTargetDelay / jitterBufferEmittedCount`
  and compare against `jitterBufferMinimumDelay` to separate your influence from network effects. `[V]`

### 4.3 Break the A/V sync coupling

- If audio and video share a MediaStream (same `a=msid`), Chromium's
  `rtp_streams_synchronizer2.cc::UpdateDelay` adds playout delay to keep them in sync — and it
  kicks in as soon as the first audio sender report arrives, which is why latency mysteriously
  *increases* a second or two into a session. `[V]`
  <https://groups.google.com/g/discuss-webrtc/c/ZvAHvkHsb0E/m/Af9RiRAFAQAJ> (Jul 2022; Ke Wu,
  Philipp Hancke, Kevin Wang)
- Workaround confirmed in-thread: **put audio and video in separate MediaStreams** (munge the
  `a=msid`). Sync drift was reported as not noticeable. `[V]`
- The spec reinforces this: if audio and video tracks are synchronised, the UA uses the **larger**
  of the two receivers' `jitterBufferTarget` values for both. `[V]`
- Selkies additionally recommends keeping one transport (`rtcp-mux` + `BUNDLE` + `mid`) while
  still isolating the streams so you get one ICE/DTLS session without the sync penalty. `[V]`

### 4.4 Other knobs

- **`contentHint`** on the track (mst-content-hint): `'motion'` → maintain-framerate degradation;
  `'detail'` / `'text'` → maintain-resolution, and `'text'` additionally enables AV1 text tools.
  For a desktop stream you want readable text under bandwidth pressure → `'text'`, unless the
  workload is video/3D → `'motion'`. `[V]` <https://www.w3.org/TR/mst-content-hint>
- **Do NOT send the `color-space` RTP header extension** — Selkies reports it causes browsers to
  bypass hardware decoding. `[V]` (selkies#157)
- **NACK/RTX**: one extra RTT, so useful only while RTT ≪ frame budget. **FEC**: zero added
  delay but expensive — WebRTC has been observed raising FEC to 50% of the video payload at 4%
  loss and 80% at 10% loss. `[V]` <https://bloggeek.me/webrtc-media-resilience/>,
  <https://getstream.io/resources/projects/webrtc/advanced/media-resilience/>
  Sensible policy: NACK/RTX on, PLI for recovery, **FlexFEC off by default**, enable FEC only
  on sustained measured loss with bandwidth headroom. `[I]`
- **transport-cc** (transport-wide congestion control) + **GCC**: the receiver reports per-packet
  arrival times; all estimation now lives on the sender, with a delay-based and a loss-based
  estimator and the lower of the two winning. Swoop's host therefore owns rate control end to
  end — good, because you can bias it toward latency instead of throughput. `[V]`
  <https://bloggeek.me/webrtcglossary/transport-cc/>
- **`requestVideoFrameCallback()`** on the `<video>` element gives `captureTime` (reconstructed
  for remote sources from RTCP SR + RTP timestamps), `receiveTime`, `presentationTime`,
  `expectedDisplayTime` and `processingDuration` — this is your production glass-to-glass
  telemetry, free. `[V]` <https://wicg.github.io/video-rvfc/>, <https://web.dev/articles/requestvideoframecallback-rvfc>

### 4.5 What floor does the media path actually reach?

- Un-tuned Chrome: a developer measured a **consistent 80 ms jitter-buffer time** against 1–2 ms
  in his native client (discuss-webrtc, 2023-03-05; Harald Alvestrand responded pointing at
  `playoutDelayHint`). `[V]` <https://groups.google.com/g/discuss-webrtc/c/jkn_aW_aK9Q>
- Philipp Hancke, in the A/V-sync thread, characterised "less than 100 ms and goes up and down a
  bit" as *expected* default behaviour. `[V]`
- With `playout-delay min=max=0` + separate MediaStreams, the remaining receiver cost is
  depacketise + decode + one compositor vsync. **Estimate 15–40 ms at 60 Hz. `[I]`** I could not
  find a published, instrumented measurement of the tuned floor in Chrome; treat this as the
  number to verify in a spike, not as established fact.
- WebCodecs path estimate: decode 5–15 ms + present 0–16 ms → **~10–30 ms**, but with *zero*
  jitter absorption that you didn't build yourself. `[I]`

### 4.6 The hybrid worth prototyping

`RTCRtpScriptTransform` (WebRTC Encoded Transform) reached **Baseline cross-browser in October
2025** — Safari shipped it in 2022, Firefox 2023, Chrome updated from its 2020 `createEncodedStreams`
prototype to the standard API. `[V]`
<https://developer.mozilla.org/en-US/docs/Web/API/WebRTC_API/Using_Encoded_Transforms>,
<https://blog.mozilla.org/webrtc/end-to-end-encrypt-webrtc-in-all-browsers/>

This raises a genuinely attractive option: **use the WebRTC media transport (for ICE, SRTP,
NACK/RTX, transport-cc, GCC and pacing) but pull assembled encoded frames out of a receive-side
`RTCRtpScriptTransform` in a worker and decode/present them yourself via WebCodecs + WebGPU**,
bypassing the jitter buffer and the `<video>` compositor entirely.

**Caveat, stated plainly: I could not verify from a primary source whether the receive-side
transform runs *before* or *after* libwebrtc's frame buffer, nor whether abandoning frames
instead of writing them back is well-defined.** `[I]` This is the single highest-value
one-day spike in the whole browser workstream.

---

## 5. Input capture

### 5.1 Pointer Lock

- Supported in Chromium, Firefox and **Safari 10.1+ on macOS**. **No support on iOS/iPadOS in
  any version** — WebKit has never enabled it there. `[V]`
  <https://caniuse.com/pointerlock>, <https://developer.mozilla.org/en-US/docs/Web/API/Pointer_Lock_API>
- Requires a user gesture. `requestPointerLock()` now returns a `Promise` in Chromium and
  WebKit. `[V]`
- **`unadjustedMovement: true`** removes OS pointer acceleration/ballistics — essential for a
  1:1 remote pointer. Chromium **81+** `[V]`; Safari **18.4+** `[V]`
  (<https://webkit.org/blog/16574/webkit-features-in-safari-18-4/>); Firefox **152+** by default,
  but **rejects with `NotSupportedError` on Linux and Android** `[V]`
  (<https://bugzilla.mozilla.org/show_bug.cgi?id=2037802>).
  → Always `await` the request and fall back to adjusted movement rather than failing hard. `[I]`
- Chrome 130 (Sept 2024) made both keyboard lock and pointer lock require explicit user
  permission. `[V]` <https://developer.chrome.com/docs/capabilities/web-apis/keyboard-lock>

### 5.2 Keyboard Lock

- `navigator.keyboard.lock()` / `.unlock()`. **Chrome 68+ and Edge 79+ only. Not Firefox, not
  Safari, not iOS.** `[V]` <https://caniuse.com/mdn-api_keyboard_lock>
- Firefox bug 700123 is open; a Mozilla engineer noted in late 2025 that the spec hasn't been
  updated since 2022 and it is not an interop priority for 2026. `[V]`
- Requirements: **secure context**, **transient user activation**, and **JavaScript-initiated
  fullscreen** (F11 user-initiated fullscreen does *not* count). `[V]`
  <https://wicg.github.io/keyboard-lock/> (spec dated 2021-10-06)
- Captures Escape, Alt+Tab, Cmd+`, Ctrl+N, Ctrl+W etc. Call with no argument to lock everything,
  or with a `KeyboardEvent.code` array: `lock(["KeyW","KeyA","KeyS","KeyD"])`. `[V]`
- **Permanently uncapturable:** Windows **Ctrl+Alt+Del** (secure attention sequence), **Win key**,
  **Alt+Tab**; macOS **Cmd+Tab**, **Cmd+Q**. `[V]`
- Escape held for **2 seconds** always exits the lock — the spec mandates a user escape hatch. `[V]`

**Consequence for Swoop: the "captures everything" experience exists only in Chrome and Edge.
Safari and Firefox users will leak Cmd+W / Ctrl+W / Cmd+Q to the local browser.** Mitigate with a
prominent "best in Chrome/Edge" affordance and a host-side soft-key palette (an on-screen
Win/Alt+Tab/Ctrl+Alt+Del button row). `[I]`

### 5.3 Key mapping

- **Use `KeyboardEvent.code`, not `.key`.** The UI Events spec names the use case explicitly:
  `code` is "intended for users interested in the key pressed without layout modifications … an
  example use case being **trapping all keys in a remote desktop client to send to the remote
  host**". `code` is a physical position (≈ a scancode); `.key` is layout- and IME-dependent. `[V]`
  <https://w3c.github.io/uievents/split/keyboard-events.html>
- Map `code` → Windows scancode → `SendInput` on the host. This is layout-independent and
  correct for gaming (WASD stays WASD on AZERTY). `[I]`
- **macOS Cmd → Windows Ctrl/Win**: `MetaLeft`/`MetaRight` arrive as `code` values. Remap
  `Meta` → `Ctrl` for text editing (Cmd+C/V/Z/A) and offer a user toggle for `Meta` → `Win` for
  shell shortcuts. Cmd+Tab and Cmd+Q never reach you at all (§5.2). `[I]`
- **Dead keys / IME are a real, unsolved-in-the-browser problem.** Microsoft documents dead-key
  and IME breakage in the Azure Virtual Desktop / Windows App web clients across browsers, and
  the practical workarounds are (a) let the user pick an explicit keyboard layout in connection
  settings, and (b) use a **Unicode-based** path so the browser emits the completed character as
  a single input event instead of two keystrokes. `[V]`
  <https://learn.microsoft.com/en-us/answers/questions/5777174/>
  → **Design for two input modes: a scancode mode (default, gaming-correct) and a Unicode/text
  mode for composed characters, switched automatically when an IME composition is active.** `[I]`

### 5.4 High-frequency pointer input

- **Pointer Events 3 is a W3C Recommendation as of 2026-06-30.** `[V]`
  <https://www.w3.org/TR/2026/REC-pointerevents3-20260630/>
- `pointerrawupdate` fires as fast as the browser can produce events (bypassing `pointermove`
  rate-limiting); `getCoalescedEvents()` returns the merged sub-events. MDN warns
  `pointerrawupdate` listeners can hurt page performance — add them only if you consume them at
  that rate. `[V]`
- **Chrome, Edge and Firefox support `getCoalescedEvents()` and can surface >1000 Hz. Safari
  implements neither `getCoalescedEvents` nor `pointerrawupdate`, so readings cap near 1000 Hz
  regardless of the mouse.** `[V]`
- For Swoop: in relative mode, accumulate `movementX/movementY` across coalesced events and send
  one delta per host frame tick (or per input packet at ~500–1000 Hz), rather than one datagram
  per raw event. `[I]`
- Touch/tablet: Pointer Events unify mouse/pen/touch; you need `touch-action: none` on the
  surface to suppress browser gestures, and a trackpad-emulation mode (MoonlightWeb ships
  exactly that: "touch trackpad, virtual keyboard"). `[V]/[I]`

---

## 6. Clipboard

### 6.1 What the API actually permits

- **Write** (`navigator.clipboard.write`): Chrome/Edge, Safari (user-gesture-gated), Firefox
  126+. Types: `text/plain`, `text/html`, `image/png` are the sanctioned built-ins. `[V]`
- **Read** (`navigator.clipboard.read` / `readText`):
  - Chrome/Edge: `clipboard-read` permission + transient activation.
  - **Safari: no clipboard permissions at all** — read requires a user gesture, and Safari
    surfaces an ephemeral **Paste** context menu the user must click. `[V]`
  - **Firefox 147+**: read works in a secure context with transient activation **after the user
    clicks the paste prompt in an ephemeral context menu** (introduced for web pages in
    Firefox 127). `[V]`
  <https://developer.mozilla.org/en-US/docs/Web/API/Clipboard_API>
- **Web custom formats** (`"web "` prefix + MIME, e.g. `"web text/rtf"`): **Chrome/Edge 104+
  only.** Not Safari, not Firefox. `[V]`
  <https://developer.chrome.com/blog/web-custom-formats-for-the-async-clipboard-api>
- **There is no clipboard-change event on the web, in any browser.** `[V]`

### 6.2 What "full clipboard sync" can realistically mean

It cannot mean "the two clipboards are continuously mirrored". The honest ceiling is:

1. **Host → browser**: the host pushes its clipboard over the data channel whenever it changes;
   the client writes it with `navigator.clipboard.write()` **on the next user gesture** (or
   holds it in a shadow buffer and offers a "paste from remote" affordance). `[I]`
2. **Browser → host**: poll `navigator.clipboard.read()` on **focus / visibilitychange**, which
   is precisely what **Chrome Remote Desktop** does — "synchronization takes place whenever the
   window loses focus, as there is no web API to detect clipboard change". `[V]`
   <https://support.google.com/chrome/thread/10414375/>
3. **Intercept the real `copy`/`cut`/`paste` DOM events** produced by the user's own Ctrl+C/V.
   **Apache Guacamole** does exactly this and documents the limit: "the copy and paste events can
   only be relied upon in response to the keyboard shortcuts which cause copy/paste actions on
   the local machine", with a text area in the menu as the manual escape hatch. Guacamole's own
   earlier approach "proved so problematic that it was disabled by default". `[V]`
   <https://guacamole.apache.org/doc/gug/using-guacamole.html>,
   <https://guacamole.apache.org/faq/>
4. **Conflict with Keyboard Lock**: once you lock the keyboard, Ctrl+C/Ctrl+V go to the *host*,
   not the browser — so the `copy`/`paste` event route disappears and you're back to (1)+(2).
   This is the central design tension and it needs an explicit decision. `[I]`

**Recommendation:** text + `image/png` both directions; host→client pushed eagerly and applied
on gesture/focus; client→host polled on focus and on an explicit "sync clipboard" hotkey that
Swoop deliberately does *not* forward. Do not promise RTF/custom formats (Chrome-only). `[I]`

### 6.3 File transfer

- **Drag-and-drop → data channel** is the portable path: HTML5 drag/drop + `File` reads work
  everywhere; chunk at ≤16 KiB over a reliable ordered channel. `[I]`
- **File System Access API** (`showSaveFilePicker`, `showDirectoryPicker`) for host→client
  downloads: **Chrome/Edge 86+, Opera 72+; not Safari, not Firefox** (both ship only OPFS). `[V]`
  <https://caniuse.com/native-filesystem-api>
  → Use an `<a download>` blob fallback on Safari/Firefox. `[I]`

---

## 7. Audio

- Opus over a WebRTC audio track. The relevant `a=fmtp` parameters are `maxaveragebitrate`,
  `maxplaybackrate`, `minptime`, `stereo`, `cbr`, `useinbandfec`, `usedtx`. `[V]`
  <https://datatracker.ietf.org/doc/html/draft-ietf-payload-rtp-opus-04> (now RFC 7587)
- **Stereo requires `stereo=1; sprop-stereo=1`** in the fmtp line; without `sprop-stereo=1` the
  stream is muxed to mono (WebRTC issue 41481053). `[V]`
- **`ptime` is pure sender-side latency** — a 20 ms ptime adds 20 ms. `minptime=10` with 10 ms
  packets is the low-latency setting, at a packet-rate/overhead cost. `[V]`
- **NetEQ**, WebRTC's audio jitter buffer, is adaptive and will grow on jitter. `playoutDelayHint`
  applies to audio receivers too. Selkies tracks reducing NetEQ latency with Opus+RED as an open
  issue (#153). `[V]` <https://webrtchacks.com/how-webrtcs-neteq-jitter-buffer-provides-smooth-audio/>
- **Autoplay**: **muted autoplay is always allowed**; unmuted playback needs a user gesture or a
  sufficient Media Engagement Index. Notably, **"while there is an active capture session,
  autoplay will be allowed for WebRTC applications"** — i.e. if the page holds a live mic/camera
  capture, autoplay is granted. `[V]` <https://developer.chrome.com/blog/autoplay>
  → Swoop should **start muted and unmute on the first click**, which is also the gesture you
  need for pointer lock and fullscreen. Bundle all three into one "click to connect". `[I]`
- Per-stream mute/volume: set `HTMLMediaElement.volume`/`.muted` per `<video>`/`<audio>` element,
  one per stream window. `[I]`

---

## 8. Cursor

### 8.1 The established pattern

Host renders the desktop **without** the cursor, and sends cursor **shape + hotspot + visibility**
out-of-band; the client draws it locally at the last-known local pointer position. This is
documented as the industry technique — US patent application 20160330260 ("Ultra-Low Latency
Remote Application Access") describes streaming video from the server while "render[ing] a
cursor separately on the client device… the remote application may send cursor bitmaps and other
cursor information to the client device, which may be rendered by the client device to give a
near-native response time and feel". `[V]`
<https://patents.justia.com/patent/20160330260>

Parsec's cursor stack rides on SDL2, and Parsec has publicly documented shipping an SDL2 patch
because **the cursor hotspot was wrong** (the I-beam selected from its upper-left corner) — a
direct warning that hotspot handling is where this goes wrong. `[V]`
<https://parsec.app/blog/an-update-to-sdl2-to-fix-cursor-bugs-3aa7ae5ed97b>

### 8.2 Browser mechanics

**Option A — CSS `cursor: url(...) hx hy, auto`:**
- Pros: the compositor draws it; zero JS per mouse move; genuinely zero-lag.
- **Size limits are the trap**: Firefox and Chromium cap custom cursors at **128×128** by default,
  and **cursors larger than the UA maximum are silently ignored** (you get the default arrow, not
  a scaled one). Historically Safari accepted only 16×16/20×20/20×40/32×32/64×64. **32×32 is the
  only universally safe size.** `[V]`
  <https://developer.mozilla.org/en-US/docs/Web/CSS/cursor>
- Format: PNG is required by spec; SVG 1.1 static with an intrinsic size is also required;
  `.cur` is widely supported on desktop. Windows cursors are commonly 32×32 so this mostly fits,
  but **high-DPI 64×64/128×128 Windows cursors will be dropped by Safari**. `[V]/[I]`
- Hotspot: the two numbers after the URL. Must come from the host's `CURSORINFO`/`ICONINFO`
  hotspot, not guessed. `[I]`

**Option B — overlay element / draw into the canvas:**
- Pros: no size limit, alpha/animation freedom, and it's the only way to render **other viewers'**
  cursors in a multi-user session.
- Cons: costs a JS frame (~1 vsync) and can visibly trail the real pointer. `[I]`

**Recommendation:** CSS `cursor:` for the local user's own cursor, **cached as data-URLs keyed by
a host-side cursor-shape ID** so a shape change is a single style write; overlay elements for
every *other* participant's cursor (where a frame of lag is irrelevant and a name label is
wanted). `cursor: none` in relative/locked mode when the host draws it into the frame. `[I]`

### 8.3 Absolute vs relative

- **Absolute** (no pointer lock): client sends normalised (x, y); the local OS cursor is visible
  and the remote cursor follows. Correct for desktop/productivity, survives Safari/iOS where
  pointer lock is unavailable. `[I]`
- **Relative** (pointer lock + `unadjustedMovement`): client sends deltas; local cursor hidden.
  Required for games and any app that itself grabs the pointer. `[I]`
- KasmVNC/noVNC document the same duality — "when engaged, the cursor is set to center screen and
  relative movements are provided to the remote desktop; the cursor is typically hidden in games
  when in relative cursor mode". `[V]` <https://kasmweb.com/kasmvnc/docs/master/clientside.html>
- Switch automatically: relative when the host reports the foreground app has captured the
  cursor, absolute otherwise. `[I]`

---

## 9. Multi-window / multi-stream limits

### 9.1 Concurrent hardware decoders

- **I could not verify a documented per-browser or per-tab cap on concurrent hardware video
  decode sessions in Chromium.** `[Unverified]` What is established:
  - NVIDIA's **encode** (NVENC) sessions are capped on consumer GPUs; **decode** has "no hard
    limit on the number of decoders that can run in parallel — it is limited by availability of
    system resources". `[V]` <https://forums.developer.nvidia.com/t/number-of-simultaneous-video-decoders/47819>
  - Chrome **falls back to a software decoder** when the hardware path fails to produce a
    configuration, rather than erroring out. `[V]` (chromium `d3d11_video_decoder.cc`)
  - **For HEVC in WebRTC there is no software fallback** (§1.1), so on Chrome a
    hardware-decoder exhaustion on the Nth window shows up as **failed H.265 negotiation or a
    black stream**, not as a CPU-decode slowdown. `[I]` **This is the most likely multi-window
    failure mode and needs an explicit soak test (open 2/4/6/8 streams).**
  - Observed in the field: users "with fast CPUs can often increase the number of video streams
    that can be viewed simultaneously by **disabling** GPU-accelerated decoding in Chrome" —
    i.e. GPU decode is the practical constraint on stream count. `[V]`
    <https://support.ipconfigure.com/hc/en-us/articles/360023105331>
- **Mitigation to design in now**: per-stream codec downgrade (HEVC → H.264 on the (N+1)th
  window), and a resolution/framerate ladder that drops background windows. `[I]`

### 9.2 Background-tab throttling

- **`requestAnimationFrame` does not fire in a hidden tab** — behaviour unchanged since 2011. `[V]`
  <https://developer.chrome.com/blog/background_tabs>
- **WebRTC is exempt from intensive timer throttling**: "an RTCPeerConnection with an 'open'
  RTCDataChannel or a 'live' MediaStreamTrack … keeps the page from being throttled." Pages
  playing audio are also treated as foreground. `[V]`
  <https://developer.chrome.com/blog/timer-throttling-in-chrome-88>
- **Consequence for the WebCodecs path**: never drive presentation from `rAF`. Drive it from the
  `VideoDecoder` output callback in a **worker** with **OffscreenCanvas**, so a backgrounded or
  occluded window keeps decoding and keeps its pipeline warm. `[I]`
- Separate top-level *windows* that are visible are not "hidden", so multi-window is fine —
  the hazard is a stream in a background **tab**. `[I]`

### 9.3 Fullscreen + multi-monitor

- The **Window Management API** (`window.getScreenDetails()`, `Screen.isExtended`) lets you
  enumerate displays and pass a target screen to `requestFullscreen({ screen })`. **Chrome 104+,
  permission-gated (`window-management`), not in Firefox or Safari.** W3C Working Draft
  2026-08-28. `[V]` <https://www.w3.org/TR/2026/WD-window-management-20260828/>,
  <https://developer.chrome.com/docs/capabilities/web-apis/window-management>
- **Keyboard Lock requires JS-initiated fullscreen** (§5.2), so the fullscreen call and the
  keyboard lock are coupled: `elem.requestFullscreen({screen}).then(() => navigator.keyboard.lock())`. `[I]`
- On Safari/Firefox you get plain `requestFullscreen()` on whatever display the window is on,
  and no keyboard lock. `[I]`

---

## 10. Network-side browser constraints

- **mDNS host-candidate obfuscation is the default.** Chrome advertises a random
  `<uuid>.local` hostname instead of the LAN IP in host candidates. Same-LAN peers can still
  resolve it over mDNS, so same-LAN P2P still works — but **your signalling server and any
  logging see only the `.local` name**, and any host-side logic that keys on the peer's LAN IP
  will break. `[V]`
  <https://bloggeek.me/psa-mdns-and-local-ice-candidates-are-coming/>
- Enterprises can opt specific origins out via the **`WebRtcLocalIpsAllowedUrls`** Chrome policy
  (URL-pattern allowlist matched against the requesting origin); if matched, real local IPs
  appear in ICE candidates. `[V]`
  <https://chromeenterprise.google/policies/web-rtc-local-ips-allowed-urls/>
  → Worth documenting for Swoop's enterprise customers as an optional same-LAN optimisation. `[I]`
- **VPNs / enterprise policy**: a VPN commonly forces srflx/relay candidates and can cause
  hairpinning failures; enterprise proxies frequently block UDP entirely. `[I]`
- **TURN over TLS 443 is the escape hatch, and Cloudflare supports it**: `turn.cloudflare.com`,
  UDP 3478, TCP 3478 **and 80**, **TLS 5349 and 443**, TLS 1.1/1.2/1.3. Free when used with the
  Realtime SFU, otherwise **$0.05 per real-time GB** outbound. Per-allocation rate limits exist
  (new IPs/sec, packet rate, and a **~50–100 Mbps** data-rate band). **Custom TURN domains work
  for UDP and TCP but NOT for TLS.** `[V]`
  <https://developers.cloudflare.com/realtime/turn/>
  → At 10–50 Mbps per stream, a relayed session is **$0.05 × ~(5–22 GB/hour) ≈ $0.25–1.10/hour**
  and brushes the per-allocation ceiling. **TURN must be a genuine last resort, and you need
  telemetry on the relayed fraction from day one.** `[I]`
  Note also that TLS-intercepting corporate proxies break TURN-over-TLS (an open Cloudflare
  community thread). `[V]`
- **`iceCandidatePoolSize`**: pre-gathers candidates before `setLocalDescription`, so
  STUN/TURN round-trips overlap with signalling and pooled candidates fire immediately on
  `setLocalDescription`. It is a pure performance optimisation with no other observable effect. `[V]`
  <https://chromestatus.com/feature/4973817285836800>
  → Set it to 1–2 on the client at page load, before the user even picks a machine. `[I]`

---

## 11. Recommendation

**Primary path — WebRTC media track, HEVC where available, H.264 everywhere else:**

1. Offer `video/H265` (Main, `level-id` matching your real max resolution, `tx-mode=SRST`) then
   `video/H264` then optionally `AV1`, ordered by `setCodecPreferences()` after checking
   `RTCRtpReceiver.getCapabilities('video')`.
2. **Host always sends the `playout-delay` header extension with min=0, max=0.**
3. Audio and video in **separate MediaStreams**.
4. `contentHint = 'text'` (desktop) or `'motion'` (game/3D).
5. NACK/RTX on, PLI for recovery, FlexFEC off unless measured loss demands it, transport-cc on.
6. Do **not** send the `color-space` header extension.
7. `jitterBufferTarget` left alone or set to a small non-zero value (20–40 ms) — never 0.
8. Present via the `<video>` element; instrument with `requestVideoFrameCallback()`.
9. `iceCandidatePoolSize: 2`; Cloudflare TURN incl. `turns:…:443` as fallback.

**Expected receiver-side latency: ~15–40 ms tuned `[I]`, vs ~80–150 ms untuned `[V]`.**

**Fallback / high-control path — DataChannel (or encoded-transform) + WebCodecs + WebGPU:**
- Annex-B HEVC/H.264, `optimizeForLatency: true`, `hardwareAcceleration: 'prefer-hardware'`,
  decode in a worker, present with `importExternalTexture` into an OffscreenCanvas.
- **Expected receiver-side latency: ~10–30 ms `[I]`**, at the cost of building your own pacing,
  bandwidth estimation and loss recovery on a congestion controller (dcSCTP, 400 ms min RTO)
  that was not designed for it.
- **MoonlightWeb proves the shape is viable** (WebCodecs + WebGPU + AudioWorklet over WebRTC
  DataChannels *and* media tracks) `[V]`; **Parsec's own web client proves that doing WebRTC
  without hardware decode is not** `[V]`.
- **Spike first: `RTCRtpScriptTransform` on the receiver to get encoded frames out of the
  WebRTC transport and into WebCodecs.** It is Baseline cross-browser as of Oct 2025 `[V]`, and
  it would give you WebRTC's transport with WebCodecs' presentation control. Whether the
  transform sits before the jitter buffer is **unverified** and is the thing to prove.

**Key API choices:**
- Input: Pointer Lock + `unadjustedMovement`; Keyboard Lock (Chrome/Edge only) inside
  JS-initiated fullscreen; `KeyboardEvent.code` → scancode, with a Unicode mode for IME;
  `pointerrawupdate` + `getCoalescedEvents` where available, coalesced to one delta per tick.
- Clipboard: text + `image/png`, host→client on gesture/focus, client→host polled on focus,
  plus an explicit sync hotkey that Swoop does not forward.
- Cursor: host sends shape+hotspot+visibility out of band; client applies **CSS `cursor:` at
  ≤32×32** for its own pointer; overlay elements for other viewers.
- Audio: Opus, `stereo=1; sprop-stereo=1`, `minptime=10`, separate MediaStream, **start muted and
  unmute on the same click that grants pointer lock and fullscreen.**

---

## 12. Top risks

1. **HEVC coverage is narrower than it looks.** No software fallback anywhere in Chrome; Linux
   needs VAAPI; Firefox never; Edge receive unverified. H.264 is not a nicety, it is the path
   a large minority of sessions will take. `[V]`
2. **Keyboard Lock is Chrome/Edge-only and shows no sign of changing.** Safari and Firefox users
   will lose Cmd+W/Ctrl+W to the browser. This is a product decision, not a bug to fix. `[V]`
3. **Multi-window hardware decoder exhaustion** is undocumented and, for HEVC in WebRTC,
   fails *hard* rather than degrading. Soak-test it. `[Unverified]`
4. **Clipboard can never be transparently bidirectional**, and Keyboard Lock destroys the
   `copy`/`paste` event route. Set expectations in the UI. `[V]`
5. **TURN-relayed sessions are expensive and rate-limited** at 10–50 Mbps
   (~$0.25–1.10/hour on Cloudflare, against a 50–100 Mbps per-allocation band). `[V]/[I]`
6. **iOS/iPadOS Safari has no Pointer Lock at all** — a browser client there is view/touch only. `[V]`
7. **Chrome's A/V-sync coupling silently adds latency a second into the session** and will look
   like a network problem if you don't know about it. `[V]`

## 13. What I could not verify

- Whether **Edge** enables `WebRtcAllowH265Receive` (only the *send* gap is documented). **Test it.**
- Any **published instrumented measurement of tuned Chrome/Safari WebRTC receiver latency** with
  `playout-delay=0`. My 15–40 ms figure is an inference.
- Whether a receive-side **`RTCRtpScriptTransform` runs before libwebrtc's frame buffer**, and
  whether dropping frames there instead of writing them back is well-defined.
- Any **documented Chromium cap on concurrent hardware decoder sessions.**
- Whether **`desynchronized` composes with OffscreenCanvas in a worker.**
- **Safari's `jitterBufferTarget` status** (WebKit/standards-positions#317 is the tracking issue;
  I did not find a shipped-in-Safari-N statement). Safari honours the *playout-delay header
  extension*, which is the path that matters anyway.
- **MoonlightWeb's "<20 ms" claim** is vendor marketing with no published methodology.
- Firefox's exact `pointerrawupdate` support status (MDN flags the feature as non-Baseline;
  `getCoalescedEvents` is confirmed supported).
- Cloudflare TURN's per-allocation "packet throughput" limit — the docs' phrasing was ambiguous
  in the excerpt retrieved.

---

## 14. Sources (with dates)

**WebRTC H.265**
- Chrome Platform Status, "H265 (HEVC) codec support in WebRTC", feature 5153479456456704 —
  created 2025-02-28, updated 2025-08-22. <https://chromestatus.com/feature/5153479456456704>
- blink-dev, "Intent to Ship: H265 (HEVC) codec support in WebRTC" (2025).
  <https://groups.google.com/a/chromium.org/g/blink-dev/c/3h8lL8a377c>
- IETF draft-ietf-avtcore-hevc-webrtc-09, "H.265 Profile for WebRTC", Standards Track, expires
  2027-01-21. <https://datatracker.ietf.org/doc/html/draft-ietf-avtcore-hevc-webrtc>
- aboba/hevc-webrtc issue #3, "tx-mode". <https://github.com/aboba/hevc-webrtc/issues/3>
- W3C WebRTC-SVC. <https://w3c.github.io/webrtc-svc/>
- WebKit, "Release Notes for Safari Technology Preview 179" (WebRTC HEVC RFC 7798).
  <https://webkit.org/blog/14532/release-notes-for-safari-technology-preview-179/>
- Chris Hiszpanski, "Does your browser support WebRTC + H.265?" — 2024-07-07, updated Apr 2025.
  <https://chris.hiszpanski.name/posts/is-webrtc-hevc-supported/>
- VDO.Ninja H.265 support checker. <https://vdo.ninja/h265>
- mozilla/standards-positions #1188, opened 2025-03-03. <https://github.com/mozilla/standards-positions/issues/1188>
- MSEdgeExplainers #1314, opened 2026-05-05. <https://github.com/MicrosoftEdge/MSEdgeExplainers/issues/1314>
- bluenviron/mediamtx discussion #4916 (Firefox, Aug 2025). <https://github.com/bluenviron/mediamtx/discussions/4916>
- MDN, `MediaCapabilities.decodingInfo()` (Firefox uses `"transmission"`).
  <https://developer.mozilla.org/en-US/docs/Web/API/MediaCapabilities/decodingInfo>
- Mozilla WebRTC blog, "setCodecPreferences is now in all browsers!".
  <https://blog.mozilla.org/webrtc/cross-browser-support-for-choosing-webrtc-codecs/>

**WebCodecs / HEVC / rendering**
- W3C, "HEVC (H.265) WebCodecs Registration" — 2026-06-08. <https://www.w3.org/TR/webcodecs-hevc-codec-registration/>
- StaZhu, enable-chromium-hevc-hardware-decoding. <https://github.com/StaZhu/enable-chromium-hevc-hardware-decoding>
- WebCodecs Fundamentals, "AV1, H265 support in 2026: Data from 1M+ devices" — Mar 2026,
  1,142,586 sessions. <https://webcodecsfundamentals.org/datasets/codec-analysis-2026/>
- WebCodecs Fundamentals, "Rendering" benchmark. <https://webcodecsfundamentals.org/basics/rendering/>
- w3c/webcodecs #206 (`optimizeForLatency`), #732 (1-in 1-out).
- MicrosoftEdge/WebView2Feedback #4099 (optimizeForLatency rendering delay).
- MDN, `VideoDecoder.configure()`. <https://developer.mozilla.org/en-US/docs/Web/API/VideoDecoder/configure>
- Chrome for Developers, "Video processing with WebCodecs" — updated 2025-01-22.
  <https://developer.chrome.com/docs/web-platform/best-practices/webcodecs>
- Chrome for Developers, "Low-latency rendering with the desynchronized hint" — 2019-05-02.
  <https://developer.chrome.com/blog/desynchronized>
- WebKit, "WebKit Features in Safari 26.0" — Safari 26.0 released 2025-09-15.
  <https://webkit.org/blog/17333/webkit-features-in-safari-26-0/>
- Phoronix, "Firefox 130 Now Available With WebCodecs API Enabled On The Desktop" (2024).
- W3C, "MediaStreamTrack Insertable Media Processing using Streams".
  <https://www.w3.org/TR/mediacapture-transform/>

**Transports**
- Lennart Grahl, "Demystifying WebRTC's Data Channel Message Size Limitations".
  <https://lgrahl.de/articles/demystifying-webrtc-dc-size-limit.html>
- web.dev, "Send data between browsers with WebRTC data channels".
  <https://web.dev/articles/webrtc-datachannels>
- swarmllm issue #34 (dcSCTP parameters, cwnd staircase, 400 ms RTO).
  <https://github.com/Nehanth/swarmllm/issues/34>
- W3C WebTransport (CR snapshot). <https://www.w3.org/TR/webtransport/>
- W3C News, "W3C Invites Implementations of WebTransport" — 2026. <https://www.w3.org/news/2026/w3c-invites-implementations-of-webtransport/>
- W3C p2p-webtransport. <https://w3c.github.io/p2p-webtransport/>
- w3c/tpac2026-breakouts #15, "QUIC-based options for moving real-time data between peers" (Sep 2026).
- Proposed WebTransport WG Charter 2026. <https://w3c.github.io/charter-drafts/2026/webtransport-wg-charter.html>

**Latency tuning**
- webrtc.org, "playout-delay" RTP header extension.
  <https://webrtc.github.io/webrtc-org/experiments/rtp-hdrext/playout-delay/>
- MDN, `RTCRtpReceiver.jitterBufferTarget`.
  <https://developer.mozilla.org/en-US/docs/Web/API/RTCRtpReceiver/jitterBufferTarget>
- discuss-webrtc, "Chromium audio/video sync leads to unexpected latency" — Jul 2022.
  <https://groups.google.com/g/discuss-webrtc/c/ZvAHvkHsb0E/m/Af9RiRAFAQAJ>
- discuss-webrtc, "Latency too high - Jitter Buffer questions" — Mar 2023 (80 ms observation).
  <https://groups.google.com/g/discuss-webrtc/c/jkn_aW_aK9Q>
- selkies-project/selkies #157, "[META] Optimize the WebRTC stack to the maximum" — opened 2024-05-25.
  <https://github.com/selkies-project/selkies/issues/157>
- W3C, "MediaStreamTrack Content Hints". <https://www.w3.org/TR/mst-content-hint>
- BlogGeek.me, "Cloud gaming, virtual desktops and WebRTC" (Stadia playout-delay).
  <https://bloggeek.me/cloud-gaming-virtual-desktops-and-webrtc/>
- BlogGeek.me, "WebRTC media resilience"; GetStream, "Media Resilience in WebRTC".
- BlogGeek.me, "transport-cc". <https://bloggeek.me/webrtcglossary/transport-cc/>
- WICG, `HTMLVideoElement.requestVideoFrameCallback()`. <https://wicg.github.io/video-rvfc/>
- MDN, "Using WebRTC Encoded Transforms".
  <https://developer.mozilla.org/en-US/docs/Web/API/WebRTC_API/Using_Encoded_Transforms>
- Mozilla WebRTC blog, "End-to-end-encrypt WebRTC in all browsers!" (Baseline Oct 2025).

**Input**
- WICG Keyboard Lock spec — 2021-10-06. <https://wicg.github.io/keyboard-lock/>
- Chrome for Developers, "Capture Keys with the Keyboard Lock API".
  <https://developer.chrome.com/docs/capabilities/web-apis/keyboard-lock>
- caniuse, `Keyboard.lock` (Chrome 68+, Edge 79+; no Firefox/Safari).
  <https://caniuse.com/mdn-api_keyboard_lock>
- Bugzilla 700123 (Firefox Keyboard Lock, open).
- caniuse, Pointer Lock. <https://caniuse.com/pointerlock>
- Bugzilla 2037802 "Ship Pointer Lock Unadjusted Movement" (Firefox 152).
- WebKit, "WebKit Features in Safari 18.4" (unadjustedMovement). <https://webkit.org/blog/16574/webkit-features-in-safari-18-4/>
- W3C UI Events — Keyboard Events (`code` for remote desktop).
  <https://w3c.github.io/uievents/split/keyboard-events.html>
- W3C Pointer Events 3 REC — 2026-06-30. <https://www.w3.org/TR/2026/REC-pointerevents3-20260630/>
- MDN, `pointerrawupdate`, `getCoalescedEvents`.
- Microsoft Q&A, "Remote Desktop Web Client — Dead Keys and IME issues".
  <https://learn.microsoft.com/en-us/answers/questions/5777174/>

**Clipboard / files**
- MDN Clipboard API; Chrome blog, "Web custom formats for the Async Clipboard API".
  <https://developer.chrome.com/blog/web-custom-formats-for-the-async-clipboard-api>
- Apache Guacamole Manual v1.6.0, "Guacamole's user interface" + FAQ.
  <https://guacamole.apache.org/doc/gug/using-guacamole.html>
- Google Chrome Community, Chrome Remote Desktop clipboard sync on focus change.
- caniuse, File System Access API. <https://caniuse.com/native-filesystem-api>

**Audio**
- RFC 7587 / draft-ietf-payload-rtp-opus (fmtp parameters).
- WebRTC issue 41481053 (Opus stereo muxed to mono).
- webrtcHacks, "How WebRTC's NetEQ Jitter Buffer Provides Smooth Audio".
- Chrome for Developers, "Autoplay policy in Chrome". <https://developer.chrome.com/blog/autoplay>

**Cursor**
- MDN, CSS `cursor` (128×128 cap; oversized cursors ignored).
  <https://developer.mozilla.org/en-US/docs/Web/CSS/cursor>
- US 2016/0330260 A1, "Ultra-Low Latency Remote Application Access".
  <https://patents.justia.com/patent/20160330260>
- Parsec blog, "An Update To SDL2 To Patch Cursor Bugs".
  <https://parsec.app/blog/an-update-to-sdl2-to-fix-cursor-bugs-3aa7ae5ed97b>
- KasmVNC "Client Side" docs. <https://kasmweb.com/kasmvnc/docs/master/clientside.html>

**Multi-window / network**
- Chrome for Developers, "Background tabs in Chrome 57"; "Heavy throttling of chained JS timers
  beginning in Chrome 88".
- W3C Window Management WD — 2026-08-28. <https://www.w3.org/TR/2026/WD-window-management-20260828/>
- Chrome Enterprise, `WebRtcLocalIpsAllowedUrls`.
  <https://chromeenterprise.google/policies/web-rtc-local-ips-allowed-urls/>
- BlogGeek.me, "PSA: mDNS and .local ICE candidates are coming".
- Cloudflare Realtime TURN docs. <https://developers.cloudflare.com/realtime/turn/>
- Chrome Platform Status, `RTCConfiguration.iceCandidatePoolSize`.
  <https://chromestatus.com/feature/4973817285836800>

**Comparable products**
- MoonlightWeb. <https://moonlightweb.top/> · <https://github.com/linckosz/moonlight-web>
- Selkies. <https://docs.selkies.io/> · <https://github.com/selkies-project/selkies>
- Parsec, "Use the Web App (browser)" — updated 2026-07-07.
  <https://support.parsec.app/hc/en-us/articles/32381650129300-Use-the-Web-App-browser>
- webrtcHacks, "Open Source Cloud Gaming with WebRTC" (CloudRetro) — 2020-04-15.
