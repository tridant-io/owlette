# Swoop research 01 — Parsec teardown, peer systems, browser transport, latency budget

Research date: **2026-09-17**. All source URLs and their dates are inline.
Scope: designing a Parsec-class low-latency remote desktop where a **native Windows host** streams to a **browser client**, P2P with TURN fallback, 50–100 ms input-to-photon, H.265 preferred, multiple simultaneous viewers.

Claims are marked **[V]** (verified against a primary or near-primary source, cited) or **[I]** (inference / my analysis, not directly stated by a source).

Parts 2 and 3B were produced by parallel research streams and are reproduced close to verbatim — the value in them is the exact source constants and config strings, and compressing that away would lose the point. Each carries its own "could not verify" list.

---

## TL;DR — the twelve things that change the design

1. **Parsec's browser client is a WebRTC *DataChannel* carrying the host's own H.264 elementary stream into `WebCodecs VideoDecoder` — not a media track, not MSE.** Verified by reading the live bundle at web.parsec.app on 2026-09-17. Their docs still describe the 2018 MSE design and are wrong. (Part 1C)
2. **A browser client already exists that does exactly what Swoop wants, with published measurements**: `linckosz/moonlight-web` — *"under 20 ms glass-to-glass over Wi-Fi on a LAN, ~25 ms over the Internet"*, 0.06 ms capture, 3.40 ms NVENC encode, ~1 ms HEVC decode. Read its benches before writing any code. (Part 2 §0)
3. **The 200 ms landmine: NVENC's H.264 SPS omits `bitstream_restriction`, so Chrome's D3D11 decoder holds a full DPB.** Measured **208 ms → 8.3 ms** from setting one flag. HEVC is unaffected. (Part 5.3b)
4. **Chrome's WebRTC media-track jitter buffer has a source-derived floor of ~21 ms + p95 decode**, and drains at only 100 ms/s after a hiccup. Google's own Stadia client ate 35–58 ms of it. `jitterBufferTarget` from JS is near-useless for video. (Part 3B §1a, Part 4.1b)
5. **On a media track, the lever is the sender-side `playout-delay` RTP extension with `min=0, max≈100–200 ms`** — which flips *two* Chrome mechanisms; `min=max=0` (what JetKVM ships) only flips one. (Part 5.3c)
6. **The `<video>` element costs 35–45 ms versus a canvas** (90.0 vs 54.4 ms click-to-photon, measured). DataChannel → WebCodecs → `desynchronized` canvas is the fastest browser path anyone has measured. (Part 2 §0, Part 4.1b)
7. **WebCodecs' `VideoDecoder` works in Safari 16.4+** (video interfaces only; full WebCodecs in Safari 26). Parsec's Chromium-only limitation is self-inflicted — it gates on **WASM Memory64**, which Safari does not support. Do not repeat that. (Part 1C.1a, Part 3A)
8. **HEVC to a browser is real now** — WebCodecs Chrome 130+, WebRTC Chrome 136+, Safari shipped — but **hardware-only, with no software fallback in Chrome**, Firefox is a hard no, and **Edge does not publish H.265 in WebRTC** despite being Chromium. H.264 remains the floor. (Part 3A, Part 3B §2)
9. **Reference-frame invalidation is unavailable on a media track** — libwebrtc has no RPSI, and loss notification is VP8-only behind a field trial. Your only signals are NACK and "send a whole keyframe". That alone decides the transport. (Part 6.5c)
10. **NVENC config is a solved problem**: P1 + ULL + CBR + infinite GOP + no B-frames + 1-frame VBV + DPB 4/refL0 1. Sunshine and moonlight-web converged on it independently, and P1 costs **nothing** in quality versus P4 (3.40 ms vs 7.67 ms at identical QP 25). Keep the quarter-res multipass — turning it off breaks still-screen refinement, which matters enormously for a fleet of static dashboards. (Part 6.5b)
11. **50 ms input-to-photon is LAN-and-fullscreen only. 100 ms buys you ~40–45 ms of RTT.** Four frame-quantised stages cost ~40 ms before a packet moves. 120 Hz on both ends is worth more than any protocol optimisation. (Part 4.3)
12. **The biggest unresolved risk is macOS**: an open WebCodecs bug gives 2–3 s of H.264 decode delay on a **static** desktop in Chrome *and* Firefox, unfixed by the SPS correction. A fleet viewer looks at static screens by definition. Mitigate with a minimum frame rate floor and test it on day one. (Part 5.3f)

---

## PART 1 — PARSEC TEARDOWN

### 1.1 Capture

**[V]** Parsec uses the **Windows Desktop Duplication API** (DXGI, Windows 8.1+): *"Windows (since 8.1) offers a very efficient API to capture desktop frames. The Desktop Duplication API essentially gives you a direct framebuffer grab and places the frame in video memory."*
— Parsec, "The Technology Behind A Low Latency Cloud Gaming Service" (a.k.a. "Description of Parsec Technology"), https://parsec.app/blog/description-of-parsec-technology-b2738dcc3842 — undated on page; internal references place it ~2016.

**[V]** Zero-copy is an explicit design rule: *"To minimize latency, Parsec is designed to never let the raw frame touch system memory… the raw captured frame must pass directly to the encoder, then once the frame is decoded into video memory on the client, it is rendered to the screen directly without any intermediate CPU operations."* (same post)

**[V]** Color conversion RGBA→NV12 is done **on the GPU via pixel shaders**, in both DirectX (Windows) and OpenGL (macOS). (same post)

**[V]** Marketing page restates it: *"We support the h.264 codec and low latency desktop capture, with a zero-copy GPU pipeline to the encoder."* — https://parsec.app/technology (undated).

#### Desktop Duplication API facts that matter for a design
Source: Microsoft Learn, "Desktop Duplication API", https://learn.microsoft.com/en-us/windows/win32/direct3ddxgi/desktop-dup-api (ms.date 2018-05-31, updated 2025-04-15).

- **[V]** Surface format is **always `DXGI_FORMAT_B8G8R8A8_UNORM`** regardless of display mode. (So you always pay an RGBA→NV12/P010 shader pass; there is no "give me NV12" fast path.)
- **[V]** `AcquireNextFrame` returns **dirty rects** (`GetFrameDirtyRects`) and **move rects** (`GetFrameMoveRects`). Move rects give a destination rect + source point — pure scroll/window-drag deltas with no pixel payload. *"The amount of data that is sent over the connection is reduced by receiving only data about how your client app must move regions of pixels rather than actual pixel data."*
- **[V]** The OS **accumulates** unprocessed updates and, if it runs out of metadata space, **coalesces** them into larger regions: *"the operating system starts to accumulate the updates by coalescing them with existing update regions to cover all new updates."* → DDA is a *pull* API. Latency is governed by how fast you loop, not by a push from the compositor. **[I]** Practical consequence: run a tight acquire→encode→release loop with a short timeout; every ms you hold a frame before `ReleaseFrame` is a ms of capture latency.
- **[V]** The **cursor is often NOT composited into the frame**. `DXGI_OUTDUPL_FRAME_INFO.PointerPosition` tells you whether a separate hardware pointer is visible; `GetFramePointerShape` gives the shape, and only when it changes. **[I]** This is a free win for a remote-desktop product: send the cursor shape + position out-of-band on the data channel and draw it client-side, so cursor motion is not gated by the video pipeline at all (this is what makes a remote cursor feel "local"). Parsec does exactly this — its SDK exposes a `ParsecClientCursorEvent` with `pngCursor` and a `ParsecCursor` struct (see 1.7).
- **[V]** In rotated modes the surface is returned **un-rotated** with the image rotated inside it; the client must rotate. Parsec exposes `host_rotated` for this.

### 1.2 Encode

**[V]** **Hardware only.** *"[Parsec] only support[s] hardware enabled video encoding and decoding"*, offloaded *"to special ASICs on your GPU"*. Rationale given: software encode cannot hit the latency budget. (Description of Parsec Technology, above.)

**[V]** **Measured median encode latency from Parsec's own fleet telemetry** (over "more than a quarter million recent Co-Play sessions", 60 FPS):
| Encoder | Median encode latency |
|---|---|
| NVIDIA NVENC | **5.8 ms** |
| Intel Quick Sync | **~11 ms** (stated as NVENC being "1.89 times faster") |
| AMD VCE | **15.06 ms** |
— Parsec, "Nvidia NVENC Outperforms AMD VCE On H.264 Encoding Latency In Parsec Co-op Sessions", https://parsec.app/blog/nvidia-nvenc-outperforms-amd-vce-on-h-264-encoding-latency-in-parsec-co-op-sessions-713b9e1e048a (undated; NVENC/VCE generation context ≈ 2018).
A follow-up post says newest NVIDIA parts beat RX 480/570/580 by **>3x** on encode latency, without giving numbers — https://parsec.app/blog/new-nvidia-gpus-outperform-new-amd-cards-on-h-264-compression-latency-d32784464b94.

**[V]** Combined encode+decode: *"total encode/decode latencies lower than 10 ms"* (Description of Parsec Technology).

**[V]** Parsec's own operational threshold, from the support docs: *"Decode and Encode is the time the device takes to handle a single frame… When streaming 60fps, you don't want to go above 15ms. At 30fps the threshold is 32ms."* — "Troubleshooting Lag, Latency and Quality Issues", https://support.parsec.app/hc/en-us/articles/32381352822804-Troubleshooting-Lag-Latency-and-Quality-Issues (page carries a Zendesk "Updated" date; fetched 2026-09-17).

**[V]** **Encoder settings that Parsec actually exposes** (from "All Advanced Configuration Options", https://support.parsec.app/hc/en-us/articles/32381443626516-All-Advanced-Configuration-Options, **Updated November 06, 2025**):

| Key | Default | Meaning (verbatim/condensed) |
|---|---|---|
| `encoder_bitrate` | `10` (Mbps) | *"The maximum amount of bandwidth Parsec will use while streaming video to **everyone connected to this computer**."* |
| `encoder_fps` | `60` | *"Setting this above 60 may cause instability in some devices."* |
| `encoder_min_qp` | `5` | *"The maximum quality of the video stream (a lower value means higher)… In the Parsec interface, **5 represents 'Lowest Latency' (default)**, 0 represents 'Balanced', and **64 is a special value that represents 'Highest Quality' and is equivalent to 0 but also enables multi-pass encoding.**"* |
| `host_full_fps` | `false` | "Constant FPS". *"Attempt to always stream at the full frame rate… May improve quality on the desktop after the screen goes static. **This should be disabled for games running in full screen mode.**"* |
| `network_cg_level` | `1` | Congestion algorithm: *"1 for the new sensitive setting (default), 2 for new relaxed, or 0 to test the old algorithm."* |
| `server_max_clients` | `20` | *"The maximum number of people that can connect… your bandwidth is split between the people connected, so 30mbps for 5 people would mean each person has 6mbps."* |
| `network_raw_audio` | `0` | Opus (default) vs uncompressed PCM. Both 48 kHz stereo. |

**[I]** Two strong signals here. (a) The **minimum QP is the latency knob** — Parsec's "Lowest Latency" preset is literally `min_qp=5`, i.e. *refuse to spend more bits than the channel can drain*, rather than letting the encoder produce a big frame that then takes multiple RTTs to arrive. (b) **Multi-pass encoding is treated as a quality-only mode**, confirming that a lookahead/two-pass path is off the table for interactive use. This matches the arXiv finding below that a non-disableable two-pass path blew NVENC's latency from 7 frames to 37.

**[V]** NVENC's own guidance (NVIDIA Video Codec SDK 13.0 Programming Guide, https://docs.nvidia.com/video-technologies/video-codec-sdk/13.0/nvenc-video-encoder-api-prog-guide/index.html):
- Tuning infos: high quality / **low latency** / **ultra-low latency** / lossless; presets **P1 (fastest) … P7 (best quality)**.
- Recommended: *"Low latency, with CBR"* for high-bandwidth channels; *"Ultra-low latency, with CBR"* for bandwidth-constrained.
- Rate control `NV_ENC_PARAMS_RC_CBR`; `NV_ENC_RC_PARAMS::lowDelayKeyFrameScale` to stop I-frames from causing a congestion spike.
- **Intra refresh**: `NV_ENC_CONFIG_H264::enableIntraRefresh`, `intraRefreshPeriod`, `intraRefreshCnt`. Useful when *"no intra frames are transmitted"* (infinite GOP).
- **Reference frame invalidation**: `NvEncInvalidateRefFrames`; **long-term refs**: `enableLTR = 1`.
- **Split Frame Encoding** (HEVC/AV1) partitions a frame into horizontal strips for speed, at a quality cost.
- **[V]** A key property reported in the literature: *latency is largely invariant to preset* on NVENC, so you can run P5–P7 quality at P1-class latency — not true of CPU encoders or all competitors (arXiv 2511.18688, below).

**[V]** NVENC error resilience doctrine, from NVIDIA's own docs/forums: reference-frame invalidation is *"the recommended error resiliency feature for low latency applications"*; when a client detects a lost/corrupt frame it signals the encoder to invalidate that frame and every frame that referenced it; the encoder then falls back to older short-term/long-term references and **only emits an I-frame if nothing valid is left**. It also recommends a **large DPB** so old references survive for this purpose. (NVENC Video Encoder API Programming Guide; corroborated on NVIDIA Developer Forums.)

#### Caveat on published "hardware encoder latency" numbers
**[V]** Arunruangsirilert & Katto, *"Evaluation of GPU Video Encoder for Low-Latency Real-Time 4K UHD Encoding"*, arXiv:2511.18688v1, **November 2025** — https://arxiv.org/html/2511.18688v1. Reported 4K60 end-to-end: NVIDIA RTX 5070 Ti **6–7 frames** (H.264/HEVC/AV1); Intel Arc A770 **5–8 frames** in ULL, 10–12 in normal; AMD Radeon 780M **6–9 frames**; **software encoders 41 to >90 frames**. Presets moved latency by ~1 frame; disabling B-frames helped marginally; ULL helped a lot with no RD penalty. One outlier: H.264 Quality/Normal hit **37 frames** because two-pass could not be disabled.
**⚠ Methodology caveat [V]:** *"To evaluate the end-to-end latency, Open Broadcaster Software (OBS) was utilized"*, streaming to an **SRS WebRTC server** and then a player; *"Latency was measured by capturing a side-by-side photograph of the source and playback monitors."* So **these are whole-pipeline OBS→SRS→player numbers, not isolated encoder latency.** They are ~10x Parsec's measured 5.8 ms NVENC figure. **[I] Use them as a warning about naive OBS/FFmpeg/SFU pipelines, not as an NVENC spec.** A direct NVENC API integration is roughly one frame interval, not seven.

### 1.3 Codec, chroma, bit depth

**[V]** Default codec **H.264**; H.265/HEVC is opt-in.
- `client_decoder_h265=1` — *"Attempt to stream using the H.265 video codec… falling back to H.264 if any of the computers don't support it **or any of the clients don't have this setting enabled**."* (Advanced config, Nov 2025)
- **[V] Codec is negotiated down to the worst participant:** *"If the host or a Windows client doesn't support H.265, the stream will revert to H.264 **for everyone**. If the client is macOS High Sierra or better, it will revert to **software decoding** for H.265."* — "Hardware and Software Compatibility", https://support.parsec.app/hc/en-us/articles/32381568346644-Hardware-and-Software-Compatibility (**Updated May 11, 2026**).
- **[V]** HEVC *"reduces the bandwidth usage by around half, while maintaining the same level of quality as H.264."* (same page)
- **[V]** HEVC hardware floor: NVIDIA GTX 900+ (host) / GTX 1000+ (client); AMD Radeon/Carrizo+; Intel Cherry Trail/Braswell+.
- **[V]** Historically Parsec was wary of HEVC: *"We are investigating HEVC for Parsec because of the lower bitrates required, but have found it increases latency in a lot of consumer hardware."* — "An Introduction To Video Compression", https://parsec.app/blog/an-introduction-to-video-compression-c5061a5d075e (≈2018).

**[V] 4:4:4 color** — paid (Teams/Warp) feature, and it is HEVC-only:
- `client_decoder_444=false` — *"Try to use full color (no chroma subsampling). This improves color quality but **will use the CPU to decode**. Leave this off if having problems at high resolutions."* (Advanced config, Nov 2025)
- Host requires **NVIDIA (Pascal/Turing/Ampere+) or Intel (Tiger Lake 11th-gen+, or Ice Lake 10th-gen but not Comet Lake)** with HW 4:4:4 HEVC encode, **Windows host only**. Guest gets HW decode only on Turing/Ampere+ or Intel 11th-gen+; otherwise software decode. (Hardware compat page, May 2026)
- **[V]** *"'Prefer 4:4:4 color' setting will only be effective when HEVC is enabled."* — "Improve Stream Quality and Color Accuracy", https://support.parsec.app/hc/en-us/articles/32381785123860-Improve-Stream-Quality-and-Color-Accuracy (**Updated July 07, 2026**).
- **⚠ Sources conflict here.** The advanced-config page (Nov 2025) flatly says 4:4:4 *"will use the CPU to decode"*; the hardware-compatibility page (May 2026) says *"If the guest has an NVIDIA or Intel GPU with hardware decoding support for 4:4:4 at H.265, Parsec will decode using hardware."* **[I] Most likely reading: the config blurb is stale and describes the pre-Turing fallback.** Either way, **4:4:4 HEVC hardware *decode* is the narrow constraint** — much narrower than 4:2:0 HEVC decode — so a meaningful fraction of clients will land on software decode.
- **[I]** For a text-heavy fleet/remote-desktop product 4:4:4 is the single biggest quality lever — 4:2:0 destroys coloured text and thin UI lines. But CPU decode is a latency and battery disaster in a browser, and **browser WebCodecs 4:4:4 HEVC support is an open question I could not verify** (see Part 3). Plan 4:4:4 as an opt-in "precision / still-image" mode, not the default, and consider the cheaper alternative: **detect a static screen and send a lossless or near-lossless still** (Parsec's `host_full_fps` / "Constant FPS" is a crude version of the same idea [V]). For a fleet product whose screens are mostly static dashboards and kiosks, that is worth more than full-time 4:4:4.

**[V] 10-bit** — `client_decoder_10bit=false`, *"minimally better color accuracy **at the cost of latency and network bandwidth**… only effective when HEVC is enabled."* Parsec claims Delta-E 0.5 on Intel 11th-gen+/NVIDIA RTX 2000+ pairs. (Advanced config; quality page)

**[V]** The client overlay reports: **Decode latency, Encode latency, Network latency (RTT), Bitrate, Decoder type** (Hardware/NVIDIA/AMD/Intel/Software/FFmpeg), **Codec type** (H.264 or H.265), Resolution, **Color subsampling** (4:2:0 / 4:4:4), Full Range, 10-bit, Audio codec. The advanced metrics graph adds **Host Video Capture** (ms/frame), **Host/Client Video Frame Time**, **P2P Network Latency**, **P2P Bitrate**. — "Stream Overlay, Stats, and Logging", https://support.parsec.app/hc/en-us/articles/32381603663636-Stream-Overlay-Stats-and-Logging (**March 17, 2025**).
**[I]** Copy this telemetry set verbatim. Capture / encode / decode / frame-time / RTT / bitrate is exactly the minimum instrumentation needed to argue about where latency went, and Parsec ships it to end users, which is why their support process works.

### 1.4 BUD — the native transport

Source: Parsec, "A Networking Protocol Built For Low Latency Interactive Game Streaming", https://parsec.app/blog/a-networking-protocol-built-for-the-lowest-latency-interactive-game-streaming-1fd5a03a6007 (undated; ~2018–2019).

- **[V]** BUD = "Better User Datagrams". *"based off of UDP and encrypted with **DTLS 1.2** (via OpenSSL)"*, and *"adds your basic reliability semantics like TCP, but with a highly tuned and custom congestion control algorithm."*
- **[V] No jitter buffer at all:** *"**Parsec has no buffers of any kind on video.**"*
- **[V]** Congestion control is **predictive**: they must *"detect a congestion event before it starts"* by *"reading the tea leaves of all of our networking metrics, crunching numbers really fast, and making a split micro-second decision."*
- **[V] Cross-layer design is the whole point:** *"BUD is sharing information with our streaming software and vice-versa, making split-second decisions and changing variables to deliver the lowest lag possible"*, in a way *"that using an off-the-shelf networking protocol could never do."*
- **[V]** They explicitly tried and rejected WebRTC: *"nothing could achieve the reliability of TCP with the latency of UDP."*
- **[V]** Admitted weaknesses: *"too conservative for people with higher latencies"*, plus ongoing *"issues with symmetric NATs, firewalls, and overall degraded networking performance."*
- **[V]** Claims: **97% NAT traversal success rate**, **95% of users successfully co-play**, and *"On our test setup on a LAN ethernet connection, **Parsec adds only 7 milliseconds of latency** to your game."* — https://parsec.app/technology
- **[V]** From the current "Overview" technical reference (**Updated July 07, 2026**), https://support.parsec.app/hc/en-us/articles/32361354307348-Overview:
  > *"BUD has been optimized for low-latency video delivery based on the data gathered over a **three year period**. With a **97% NAT traversal success rate** and lightning fast adjustment to packet loss and congestion, BUD is the cornerstone of the Parsec SDK… Providing reliable UDP video at the lowest latency possible while handling all sorts of messy networking situations. Built with an **ultra-responsive dynamic bitrate adjustment that is constantly adjusting based on network conditions**. It also supports … **DTLS 1.2 with AES128 or AES256 cipher enabled on every single packet** sent over the network."*
  and, notably, the codec line has been updated from H.264 to HEVC: *"**We support the H.265 codec** and low latency desktop capture, with a zero-copy GPU pipeline to the encoder. You can use whatever GPU you want — AMD gets the same love as Nvidia here. We use hardware decoding whenever possible on every platform we support, and we have **low level frame timing and synchronization optimizations** for a smooth 60 FPS stream."*
  Their stated pipeline: *"Capture raw desktop frames → Encode the raw frames → Send the encoded frames over the network → Decode the frames → Render the frames on the screen."*
  **[I]** "Ultra-responsive dynamic bitrate adjustment" + "no buffers of any kind on video" is the whole thesis: **spend the adaptation budget on the encoder's output rate, not on a receiver buffer.**
- **[V]** Audio, unlike video, **does** have a buffer: `client_audio_min_buffer_ms=50`, `client_audio_max_buffer_ms=100`. **[I]** Note the asymmetry — they buy audio robustness with 50–100 ms of buffer and give video none. Do the same: never let an audio jitter buffer set your video latency.
- **[I]** What BUD is *not* documented to use: no statement anywhere about FEC. The combination of "no video buffers" + "reliability semantics like TCP" + reference-frame invalidation implies **NACK/retransmit plus encoder-side error recovery**, with the congestion controller trying to keep loss from happening at all. Could not verify FEC either way.

### 1.5 NAT traversal, signalling, relay

Source: "Components and Connection Sequence", https://support.parsec.app/hc/en-us/articles/32361410290324-Components-and-Connection-Sequence (**Updated July 07, 2026**), and "Parsec Connectivity Requirements", https://support.parsec.app/hc/en-us/articles/32381460716180-Parsec-Connectivity-Requirements (**Updated July 08, 2026**).

- **[V]** Four components: **Clients, Hosts, Signal/WebSocket API Gateway (Parsec-hosted), STUN server (Parsec-hosted)**. Notably **no TURN in the default topology.**
- **[V]** Exact sequence: client STUNs (UDP **3478**) → gets public IP/port → sends it to host via the Signal API → host STUNs → sends its info back → *"they both attempt to connect to each other **at the same time**… The initialization of the connection depends on which connection attempt 'wins', client to host, or host to client."* Simultaneous bidirectional punch *"effectively doubles our chances to establish a session."*
- **[V]** Default path is **UPnP + UDP hole punching**. Manual **port-forward/DNAT** is the enterprise alternative.
- **[V] One UDP port per concurrent guest, sequential:** *"If your Host Start Port is 8000, you need to forward port 8000-8002 to your host computer."* Configurable via `network_server_start_port` / `network_client_start_port`.
- **[V]** Signalling/control: **TCP 443** to `kessel-ws.parsec.app` (WebSocket) and `kessel-api.parsec.app` (API). All P2P media: **UDP**, port range per settings.
- **[V]** Hard requirement: *"Host and client must not be inside a 'Double NAT' or CGNAT network."* **[I] That is a huge caveat for a consumer/fleet product — CGNAT is common on mobile and many ISPs. Parsec's answer for enterprises is a paid relay, not a free TURN. Swoop targets fleet machines behind arbitrary corporate NAT, so TURN cannot be an afterthought.**
- **[V]** Relay is an **Enterprise** feature, "High Performance Relay" (HPR), self-hosted: `app_stun_address=IP@PORT,...` (host side), `app_client_stun_address=...` (client side), `app_force_relay=2` (force all P2P over relay, WAN or LAN) or `=1` (WAN only), and `network_fast_relay_ping=true` — *"Parsec will attempt to signal all Relays at once, and use the first Relay that replies"* (latency-based relay selection), otherwise random. — Advanced config (Nov 2025); "Configure Parsec Relay Server (Legacy)", https://support.parsec.app/hc/en-us/articles/32381397579284-Configure-Parsec-Relay-Server-Legacy.
- **[I]** Design lesson: **race all relay candidates by RTT and pick the winner**, and make relay a first-class path rather than a failure mode. Parsec's own docs say hosts fall back to public STUN if no HPR is reachable unless `app_force_relay` is set.

**[V] What the relay actually is** — "Configure Parsec Relay Server (Legacy)", https://support.parsec.app/hc/en-us/articles/32381397579284-Configure-Parsec-Relay-Server-Legacy (**April 22, 2025**; it notes a v2.0 exists):
> *"The Parsec Relay Server is an on-premises high performance relay (HPR) server. It is a **lightweight server program that relays many concurrent Parsec sessions through a single IP address / port configuration**."*
- A single Linux binary `parsechpr` run under systemd: `ExecStart=/bin/parsechpr [Public IP] [WAN/public port] [LAN/internal port]`, both **UDP**. *"Using a `[private_port]` ensures that relay requests can only be originated on the `[private_port]` specified, and any relay requests attempting to be originated on `[public_port]` will be dropped."*
- **[I] The design point worth stealing: many sessions multiplexed over ONE public UDP port**, rather than TURN's default per-allocation ephemeral ports. For fleet customers whose firewall team has to approve a rule, "one UDP port" is an enormously easier ask than "a range". If you deploy coturn, configure it for single-port channel-data relaying and publish one port.

### 1.6 The web client, as *documented* (the 2018 design)

> **Read Part 1C for what actually ships today.** This section is the public paper trail; Part 1C is a teardown of the live bundle, and it contradicts the docs in two important places (the decoder is WebCodecs, not MSE, and it *does* use hardware decoding).

Source: Parsec, "A Look at Game Streaming Tech in the Browser", https://parsec.app/blog/game-streaming-tech-in-the-browser-with-parsec-5b70d0f359bc (undated; references Chrome 70 and Google Project Stream ⇒ **late 2018**), plus the Parsec SDK header (below) and "Use the Web App (browser)", https://support.parsec.app/hc/en-us/articles/32381650129300-Use-the-Web-App-browser (**Updated July 07, 2026**).

**[V] Architecture: WebRTC *DataChannel* + fragmented-MP4 + Media Source Extensions. Not a WebRTC media track.**
- *"Our web client implementation uses `RTCDataChannels` to communicate with the Parsec host, which allow for arbitrary messages to be sent via a peer-to-peer connection."* Under the hood: *"UDP wrapped in an SCTP stream wrapped in DTLS for security."*
- Decode: *"punting the video frames to an HTML `<video>` element via **Media Source Extensions**"*, exploiting a Chrome-specific feature: *"**Chrome supports a special 'low delay' mode for MSE that sets up a push model for video frames rather than the traditional buffered pull model.**"*

**[V] Confirmed independently in Parsec's own public SDK header** (`sdk/parsec.h`, mirrored at https://github.com/MalfoyJW/parsec-sdk — the upstream parsec-cloud/parsec-sdk repo is archived):
```c
typedef enum ParsecProtocol {
    PROTO_MODE_BUD  = 1, ///< Parsec's low-latency optimized BUD protocol.
    PROTO_MODE_SCTP = 2, ///< SCTP protocol compatible with WebRTC data channels.
} ParsecProtocol;

typedef enum ParsecContainer {
    CONTAINER_PARSEC = 0, ///< Parsec's custom container compatible with native decoding.
    CONTAINER_MP4    = 2, ///< MP4 box container compatible with web browser Media Source Extensions.
} ParsecContainer;
```
**[I]** This is the single most reusable idea in the whole teardown: **the host runs ONE encoder and ONE elementary stream; the only thing that differs between a native client and a browser client is (a) SCTP instead of BUD as the datagram carrier and (b) fMP4 boxing instead of the native container.** No transcode, no second encoder, no SDP/media-track negotiation, no libwebrtc jitter buffer.

**[V] Why the web client is slower — Parsec's own words** ("Use the Web App", July 2026):
> *"The web client **does not have access to low-level hardware optimizations or hardware decoding**, it's just not possible today because browsers do not give direct access to it. We're also using WebRTC and have **a lot less control over the networking** causing issues with low bandwidth connections and increased lag."*
and: *"The performance and stability on the web client is **not as good as** the downloadable version."* Native clients *"[perform] the decode/render pipeline manually to ensure hardware support and no added latency."*

**[V] Browser scope:** Chrome/Chromium only. Their stated reason (2018 post): *"82% of our homepage's visits are from Chrome… We haven't taken the time to implement Firefox because it works very differently from Chrome for handling video. Chrome has also implemented a ton of features to make low latency video streaming possible for things like Google Hangouts and Google Stadia."* Still Chromium-only in 2026, and **iOS/iPadOS Safari is not supported at all**; **macOS hosts cannot be joined from the web app**. (Hardware compat, May 2026; Use the Web App, July 2026.)
**[V]** Other browser limits they call out: Pointer Lock can only be entered in response to certain user gestures.

**[I] Reading the 2018 decision in 2026.** Parsec's MSE choice was correct *for 2018* — WebCodecs did not exist. The right 2026 shape is the same architecture (DataChannel carrying the host's own elementary stream) feeding **`WebCodecs VideoDecoder`**: `hardwareAcceleration: "prefer-hardware"`, `optimizeForLatency: true`, the decoded `VideoFrame` in your own hands to render on a `desynchronized` surface, and no MSE container tax or `<video>` presentation queue. **Parsec has in fact already made that change** — see Part 1C — but their support documentation still describes the 2018 design, and they left the *presentation* and *reliability* halves of the win on the table.

### 1.7 Multi-guest, permissions, input

**[V]** From `parsec.h`:
```c
typedef struct ParsecPermissions {
    bool gamepad;  ///< The guest can send gamepad input.
    bool keyboard; ///< The guest can send keyboard input.
    bool mouse;    ///< The guest can send mouse button.
} ParsecPermissions;
```
set per guest via `ParsecHostSetPermissions(Parsec *ps, uint32_t guestID, ParsecPermissions *perms)`. Each `ParsecGuest` carries its own `perms`, its own `ParsecMetrics {encodeLatency, decodeLatency, networkLatency}`, a `state`, `id`, `userID`, `name`, `attemptID` and an `owner` flag.

**[V]** Product behaviour matches: *"By default, guests only have controller permissions, while the owner has full permissions… the person hosting needs to manually give keyboard and mouse permissions."* Owner can kick everyone with **Ctrl+F3**; connections are approved with **Ctrl+F1**; "Approved apps" freezes the stream and blocks all guest input whenever a non-approved app is focused. — "Hosting and Permissions", https://support.parsec.app/hc/en-us/articles/32381747079572-Hosting-and-Permissions (**April 22, 2025**).

**[V]** `host_exclusive_input=0` — *"Allow only one guest to control the mouse at a time. The host will always be able to take control from the guests by moving their mouse."* (Advanced config). SDK default is `exclusiveInput = 1`.
**[I]** This is the shared-input model in one line: mouse is a **token** (one controller at a time, host preempts), keyboard/gamepad are **per-guest capabilities**. For a fleet product with multiple simultaneous viewers, that maps cleanly onto "many viewers, one driver, operator can seize control".

**[V] Multi-viewer scaling is bandwidth-split, single-encode:** `encoderMaxBitrate` is documented as *"Maximum output bitrate in Mbps, **split between guests**"*; `maxGuests` default **20**; `server_max_clients=20` with the explicit warning that 30 Mbps ÷ 5 guests = 6 Mbps each.
**[I]** So Parsec encodes once and shares the bitrate budget — the encoder is configured for the *aggregate*, not per-viewer. That is cheap, but it means one bad viewer's congestion control drags quality for everyone. **A design that wants "multiple simultaneous viewers" without cross-talk needs either simulcast/SVC (multiple encodes or temporal layers) or per-viewer rate control with a shared base layer.** Parsec does not solve this.

**[V] Input hardware emulation on the host:** Parsec ships its own **VUSB** driver plus ViGEm fallback. `host_gamepad_mode` (0=VUSB, 1=ViGEm), `host_gamepad_type` (1=Xbox 360 default, 2=DualShock 4, 3=DualSense), `host_virtual_mouse=1` (*"a dummy device that does not generate input"*, just to keep the cursor visible with no physical mouse), `host_virtual_microphone`, `host_virtual_tablet=false` (emulates a **Wacom Intuos Pro (M)** rather than using Windows Ink pen injection). (Advanced config, Nov 2025)

### 1.8 Virtual display driver and privacy mode

- **[V]** `host_virtual_monitors=0|1|2` (Warp/Teams) — additional virtual displays during owner connections, requires the **Parsec Virtual Display Driver**.
- **[V]** `host_virtual_monitor_fallback=true` (free, default on) — *"Adds a single virtual display if no other displays are present."* This is the headless-server answer, replacing HDMI/DP dummy dongles.
- **[V]** `host_privacy_mode=0|1` (Warp/Teams) — *"Shut off all physical displays while virtual monitors are enabled and someone is connected… The computer will be automatically locked after the last guest disconnects. Requires the Parsec Virtual Display Driver and at least one virtual display enabled."*
- **[V]** The overlay surfaces a dedicated **Privacy mode** failure warning: *"Privacy mode has encountered a display error and is inactive."*
- **[I]** For a fleet/kiosk/signage product this trio (virtual display fallback, privacy mode, auto-lock on last disconnect) is table stakes, and Parsec treats the display driver as the enabling dependency for all of it. It also implies an **install-time kernel/driver component** — a real consideration for silent deployment.
- **[V]** Community reimplementation of the Parsec VDD exists and documents the driver's interface: https://github.com/nomi-san/parsec-vdd.

**[V] "Add Screens" — multiple simultaneous streams from one host, with per-stream settings.** From "Multiple Monitors and Virtual Displays", https://support.parsec.app/hc/en-us/articles/32381733729044-Multiple-Monitors-and-Virtual-Displays (**Updated July 07, 2026**):
> *"'Add Screens' is a feature available for Teams and Warp customers, which lets you open up additional windows to view **up to 3 displays from the same host computer at once**. You can change the **bandwidth, resolution, chroma settings, and frame rates per screen at any time** by using the Parsec overlay in that display."*
Requires the host's displays in **Extend** (not Mirror) mode. Virtual displays: up to **3 additional**, Windows 10 1607+ / Server 2019+ / macOS 10.15+, Windows requiring the VDD.
**[I] This matters more than it looks.** It proves Parsec's host already runs **multiple concurrent encoder instances with independent rate control, resolution and chroma** — just keyed on *monitor* rather than on *viewer*. The machinery for "two encodes: one HEVC, one H.264" (see 6.4) therefore exists in a Parsec-class host; it simply isn't wired to viewer capability. That is the gap Swoop should close.
**[V]** Privacy mode detail worth noting for macOS parity: *"For MacOS, additional virtual displays are not required for Privacy mode… the physical displays remain connected and active with Privacy mode on MacOS"* — i.e. macOS privacy mode is weaker than Windows'. ("Privacy Mode", https://support.parsec.app/hc/en-us/articles/32361381211284-Privacy-Mode, **July 30, 2025**.)

### 1.9 Rendering / vsync on the Parsec client

- **[V]** `client_vsync=1` — *"**VSync increases latency**, but eliminates screen tearing. On some Intel decoders, you can actually turn this option off and continue to play without tearing."*
- **[V]** But the troubleshooting page says the opposite is sometimes true: *"If the stream is stuttering somewhat, try turning on V-sync… People usually associate V-sync with preventing screen tearing, but **on Parsec it can noticeably improve the delivery of frames in other big ways**. If you don't notice an improvement, keep it off for saving some latency."*
- **[V]** Renderer is D3D11 by default on Windows (`client_renderer=3`; Metal on macOS, OpenGL on Linux, D3D12 and Vulkan experimental). DirectX swap effect is **flip-sequential**.
- **[V]** `client_zero_copy=false` (Windows) — *"Attempt to keep decoder output in video memory, from where it is rendered… Currently this only works with D3D11 rendering."* **[I] Telling that the zero-copy *client* path is still opt-in and off by default in 2025.**
- **[V]** At 240 Hz on LAN: *"At 240 frames per second, Parsec is only **two frames behind** the server PC with VSync on. The total latency required for the entire Parsec pipeline on the LAN is roughly **4–8 milliseconds** in this test."* Setup: i7-6700K + GTX 1070 host, mini-PC + GTX 1050 Ti client, two 240 Hz monitors, 1000 fps camera, gigabit LAN, 100 Mbps cap, H.264. They add: *"We do not recommend using Parsec at 240 FPS. We only test the software at 60 FPS."* — https://parsec.app/blog/parsec-game-streaming-total-latency-at-240-frames-per-second-c0818cc0daa5
- **[V]** The input-latency DIY test: host direct = **16 ms**, via Parsec on the client = **23 ms**, ⇒ **Parsec adds 7 ms** on a gigabit LAN. Hardware: 2× AOC AG251FZ 240 Hz, 6700K + GTX 1070 host, GTX 1050 Ti client, Sony RX100 IV at 1000 fps, Makey Makey for the trigger, Counter-Strike: Source. — https://parsec.app/blog/testing-game-streaming-input-latency-on-parsec-with-diy-instructions-49ae838f45a7
- **[V]** Parsec's own VSync guidance, from "What Is Your GPU Doing When VSync Is Running In Your PC Games?", https://parsec.app/blog/vsync-technology-impact-on-pc-gaming-and-your-gpu-6307fee70d29 (undated): VSync *"uses the ultra sensitive clock on the GPU to time when the next frame should be drawn"* by *"purposefully waiting to tell the monitor to draw the image"*. Their recommendation is explicit and two-sided: for lowest latency, *"turning VSync off in the game and in Parsec"*; *"if you're optimizing for smoothness, we recommend turning VSync on in both."* They also note GPUs typically have 1–3 buffers, double buffering being most common, triple *"most of the time on Macs"*.
- **[I]** So there are **two VSync decisions in a streaming pipeline — host present and client present — and they are independent.** The host's is a sampling-phase cost you can only reduce by raising host refresh; the client's is a pacing-vs-latency trade you get to make per viewer. Expose it as a setting the way Parsec does (`client_vsync`), default it to *off* for an interactive/control session and *on* for a passive monitoring session.
- **[I]** Note both headline numbers are **240 Hz LAN**. At 60 Hz the frame cadence alone (16.7 ms) dominates them. Do not quote "7 ms" as an internet figure.

### 1.10 Parsec's own network guidance (useful as target numbers)

- **[V]** *"With network latencies below 20 ms, and bandwidth above 10 Mb/s, Parsec offers a near-native experience."* (Description of Parsec Technology)
- **[V]** *"Network is the ping between the guest and host… **Below 30ms is good, and below 60ms is still fine for most people.** If this number is constantly varying a lot, it's also a sign the connection isn't reliable."* (Troubleshooting page)
- **[V]** *"The host needs at least **10 Mbps upload and 2 Mbps download per guest**. The client needs at least 2 Mbps upload and 10 Mbps download."* (Troubleshooting page)
- **[V]** They point users at a **bufferbloat test** and recommend **SQM** on the router — i.e. they consider queue depth on the user's own uplink a first-order latency term. (Troubleshooting page)
- **[V]** Practical encode-latency gotchas they document: newer NVIDIA drivers have caused *"unusually higher encoder latency, latency spikes and significant capture issues"* (they suggest 472.12 as a known-good); **G-Sync on the host hurts encode latency**; setting Parsec to max performance in the NVIDIA control panel helps; on hybrid-GPU laptops Parsec *"needs to use whichever GPU is directly plugged into the display you want to capture"*, which is usually the iGPU for the built-in panel.

---

## PART 1B — HOST-SIDE WINDOWS FACTS THAT CONSTRAIN THE DESIGN

**[V] `SendInput` is subject to UIPI.** *"This function is subject to UIPI. Applications are permitted to inject input only into applications that are at an equal or lesser integrity level… This function fails when it is blocked by UIPI. **Note that neither `GetLastError` nor the return value will indicate the failure was caused by UIPI blocking.**"* — Microsoft Learn, https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-sendinput (ms.date 2018-12-05, updated 2025-07-01).

- **[V]** Events are inserted **serially** and *"are not interspersed with other keyboard or mouse input events inserted either by the user… or by other calls to SendInput"* — so a batch of N events is atomic with respect to local input. Useful when replaying coalesced browser pointer events.
- **[V]** *"This function does not reset the keyboard's current state."* You must reconcile with `GetAsyncKeyState` — otherwise a viewer who disconnects mid-chord leaves a stuck modifier on the host. **[I] Build an explicit "release all held keys/buttons" on viewer disconnect, kick, or permission revoke; Parsec's Ctrl+F3 kick implies they do.**
- **[I] Consequence for a fleet product:** to drive an elevated app, the UAC secure desktop, the lock screen, or Ctrl+Alt+Del, the injecting process must be at least as privileged and on the right desktop — a **SYSTEM service plus a session-attached helper that switches to the Winlogon desktop** (`OpenInputDesktop`/`SetThreadDesktop`), not a plain user-mode app. This collides with the Owlette guardrail that nothing unattended may raise a UAC prompt: remote *viewing* of a UAC prompt is fine, but Swoop must never be the thing that triggers one.
- **[I]** Desktop Duplication also fails with `DXGI_ERROR_ACCESS_LOST` across secure-desktop transitions, session switches and mode changes; the capture loop must treat access-loss as routine and re-create the duplication object.

**[V]** Absolute vs relative mouse: Parsec ships a **virtual mouse** (`host_virtual_mouse=1`, *"a dummy device that does not generate input"*) purely so the cursor stays visible on a machine with no physical mouse — a real Windows quirk for headless fleet boxes.

---



---

## PART 1C — THE **CURRENT** PARSEC WEB CLIENT, READ FROM THE SHIPPED BUNDLE

This is the highest-value finding in the report and it is not in any Parsec blog post. I fetched and read the live production bundle at **https://web.parsec.app/** on **2026-09-17**: `lib/matoya.js` (unminified, 22.8 kB), `lib/weblib.js` (6.4 kB), `lib/parsec.js` (minified, 15.9 kB). Everything below is **[V]** from that code.

### 1C.1 It is the native client, compiled to WebAssembly

`index.html` loads three scripts and then calls `MTY_Start('parsecd', body, PARSEC_ENV)`. On failure it prints:
> *"Your browser does not support the Parsec web app. The web app requires **WebGL and WebAssembly 64-bit** support."*

`parsecd` is the same binary name as the native Windows client (`C:/Program Files/Parsec/parsecd.exe`, per the support docs). `matoya.js` is Parsec's own open-source app framework, **libmatoya** (https://github.com/matoya/libmatoya). So the web client is **the native C client cross-compiled to WASM64**, with JS shims for canvas/WebGL2, `AudioWorklet`, WebSocket, fetch, pointer lock, gamepads, and — crucially — WebCodecs and `RTCPeerConnection`.

**[I]** This is a strategic pattern worth stealing: one C/Rust core, two thin platform shims. It eliminates the "the web client is a different, worse product" problem that Parsec's own support page still complains about.

#### 1C.1a Why it is *actually* Chromium-only — and the two deployment constraints that come with it

**[V]** The startup gate is `WebAssembly 64-bit` and `WebGL2`, not video. And **WebAssembly Memory64 is not supported in Safari at all**: Chrome/Edge **133 @2025-02-04**, Firefox **134 @2025-01-07**, Safari **—** (api.webstatus.dev, queried 2026-09-17). So the reason Parsec's web client excludes Safari in 2026 is a **toolchain choice**, not a media-platform limitation. WebCodecs itself shipped in Safari 26 a year ago.

**[V]** The bundle also requires **`SharedArrayBuffer` + `Atomics.wait`/`waitAsync`/`notify` + a shared `WebAssembly.Memory`**:
```js
MTY_MEMORY = new WebAssembly.Memory({ initial: 512 /*32 MB*/, maximum: 16384 /*1 GB*/, shared: true });
...
MTY.psync = new Int32Array(new SharedArrayBuffer(4));
Atomics.wait(sync, 0, 1);
```
and the live response headers on `https://web.parsec.app/` confirm the site is **cross-origin isolated**:
```
Cross-Origin-Embedder-Policy: require-corp
Cross-Origin-Opener-Policy: same-origin
```
**[I] Two hard consequences for Swoop, and they are architectural, not cosmetic:**
1. **Do not gate on Memory64.** Ship a wasm32 build (or plain JS + WebCodecs) so Safari 26+ and iPad are reachable. Parsec's exclusion of Safari is self-inflicted and is a differentiator you get almost free.
2. **COOP/COEP cross-origin isolation is contagious.** `require-corp` means every subresource must opt in with CORP/CORS headers, and the isolated page cannot casually be embedded in, or embed, ordinary third-party content. If Swoop's viewer is meant to live **inside the Owlette dashboard as an iframe or panel**, decide early: either avoid SharedArrayBuffer entirely (single-threaded WASM, or no WASM), or plan the whole dashboard route for cross-origin isolation. Discovering this after the viewer is built is expensive.

**[V]** One more Chromium-only dependency spotted: `navigator.keyboard.getLayoutMap()` (the Keyboard Map API) is used to translate `KeyboardEvent.code` into the user's physical layout. **[I]** Useful idea, but feature-detect it — Parsec already does (`if (navigator.keyboard)`), so non-Chromium clients degrade to raw `code` values rather than breaking.

### 1C.2 Transport: three *pre-negotiated* WebRTC data channels, STUN-only ICE

```js
this.b = new RTCPeerConnection({ iceServers: [{ urls: "stun:stun.parsec.gg:3478" }] });
...
function V(a, b, d, f, g) {
  a.c[d] = a.b.createDataChannel(b, { negotiated: true, id: d });
  a.c[d].binaryType = "arraybuffer";
  a.c[d].onopen = f;
  a.c[d].onmessage = g;
}
// call sites:
V(b.b, "control", 0, ...)
V(b.b, "video",   1, ...)
V(b.b, "audio",   2, ...)
```

- **[V] No media track. No `addTrack`, no `ontrack`, no SDP video m-line.** Video is application data on a DataChannel, exactly as the 2018 blog post described — the architecture survived, only the decoder changed.
- **[V] Three channels, `negotiated: true` with fixed IDs 0/1/2** — no in-band DCEP handshake, so channels are usable the instant SCTP is up.
- **[V] ⚠ The channels are left at SCTP defaults: `ordered: true`, no `maxRetransmits`, no `maxPacketLifeTime` ⇒ fully reliable and ordered.** A single lost datagram therefore **head-of-line blocks the video channel** until SCTP retransmits it — a whole RTT, minimum. **[I] This is almost certainly the mechanical reason Parsec's web client "feels laggier on bad connections" and why their docs blame "a lot less control over the networking". It is also the single easiest thing for Swoop to beat: use `{ordered:false, maxRetransmits:0}` (or a small `maxPacketLifeTime`) for video and do loss recovery in the codec layer instead.**
- **[V] ICE config contains STUN only — no TURN server at all.** Combined with the support doc's *"Host and client must not be inside a 'Double NAT' or CGNAT network"*, this confirms the free Parsec web path has **no relay fallback**; relay is the paid, self-hosted Enterprise HPR.
- **[V]** Signalling does not use standard trickle ICE. They `createOffer()`, then hand-parse the SDP down to just `{ice_ufrag, ice_pwd, fingerprint}` and send that over their own Signal API; peer candidates are re-injected as **synthesised candidate strings**:
  `"candidate:2395300328 1 udp 2113937151 <ip> <port> typ srflx|host generation 0 ufrag <ufrag> network-cost 50"`.
  **[V — Parsec confirms this in writing] The Parsec host implements its own WebRTC stack.** From "Overview", https://support.parsec.app/hc/en-us/articles/32361354307348-Overview (**Updated July 07, 2026**):
  > *"Parsec's core technology suite, the Parsec SDK, is built in cross platform C… Even our **host side WebRTC implementation (for our web client) was custom built without requiring Google's massive dependency tree.** We didn't build on top of any wrappers — we wanted full hardware control and the ability to manipulate every element of the stream to reduce latency as much as possible."*

  **[I]** That is a real engineering cost (ICE + DTLS + SCTP + your own congestion control, on the host), but it is what lets one host serve both BUD natives and browser guests from the same encoder. **The decision for Swoop is whether to pay it.** Options, cheapest first: (a) embed libwebrtc/`webrtc-rs`/Pion on the host and use it purely as a datagram carrier — you inherit ICE/TURN/DTLS/SCTP for free and simply don't use its media stack; (b) a minimal ICE/DTLS/SCTP implementation like Parsec's, for full control and a small binary; (c) both, with (a) as the shipping path and (b) as a later optimisation. **[I] Start at (a).** Parsec's reason for (b) — "full hardware control", written in an era before WebCodecs — does not apply when the browser is doing the decode and you are only carrying bytes.

### 1C.3 Video decode: **WebCodecs, not MSE** (the docs are stale)

```js
b.l.configure({
  codec: "avc1.42001e",
  hardwareAcceleration: "prefer-hardware",
  optimizeForLatency: true
});
...
c = new EncodedVideoChunk({ type: e, data: c.data, timestamp: 1e3 * performance.now(), duration: 0 });
b.l.decode(c);
```

- **[V] `VideoDecoder` + `EncodedVideoChunk`. No `MediaSource`, no `SourceBuffer`, no `<video>` element anywhere in the bundle.** Parsec migrated off the 2018 MSE "low delay" design to WebCodecs.
- **[V] `hardwareAcceleration: "prefer-hardware"` and `optimizeForLatency: true` are both set.** The support page's claim that *"the web client does not have access to … hardware decoding"* is **out of date** — it does now.
- **[V] `codec: "avc1.42001e"` = H.264 **Baseline** profile, level 3.0**, and **no `description` is supplied**, i.e. the bitstream is fed as **Annex B**. **So the browser path is H.264-only — no HEVC, no AV1, no 10-bit.** The metrics object does carry a `444` field set from `"I444" == frame.format`, so the plumbing anticipates 4:4:4, but nothing configures it.
- **[V]** Keyframe/delta is signalled **in-band by the host**, not inferred: a version/handshake packet is detected by length + magic, and a bit in the header (`getUint32(...) & 2`) marks the next chunk `"key"` vs `"delta"`. Before the handshake completes every chunk is submitted as `"key"`.
- **[V]** Decode latency is measured client-side as an EWMA of submit→output:
  `decodeLatency = 0.9*decodeLatency + 0.1*(performance.now() - chunk.timestamp/1000)`.
- **[V]** `encodeLatency` arrives from the **host over the control channel** (message type 21). **`networkLatency` is hardcoded to 0 in the web client** — the browser client does not measure RTT at all. **[I] A gap worth not copying: without RTT you cannot do sensible congestion control or adaptive buffering.**
- **[V]** Audio: `AudioDecoder` with `{codec:"opus", sampleRate:48000, numberOfChannels:2}`, f32 planar frames pushed to a queue and played through an `AudioWorkletNode('MTY_Audio')` with `minBuffer`/`maxBuffer` processor options.

### 1C.4 Render path — and a self-inflicted frame of latency

```js
this.o = a.getContext("2d");
this.o.imageSmoothingEnabled = true;
...
new VideoDecoder({ output: function (frame) {
    window.requestAnimationFrame(function () {
        ... a.o.drawImage(frame, 0, 0, w, h, offsetX, offsetY, dw, dh);
        frame.close();
    });
}, ... });
```

- **[V]** Decoded `VideoFrame`s are drawn with **`drawImage` onto a plain 2D canvas**, letterboxed to aspect ratio, **inside `requestAnimationFrame`**.
- **[V] Not** `requestVideoFrameCallback`. **Not** a `desynchronized` context. **Not** WebGL/WebGPU for the video (WebGL2 is used by libmatoya for the app UI; `mty_supports_web_gl()` gates startup on `getContext('webgl2')`).
- **[I] Gating presentation on rAF costs up to a full client frame interval (16.7 ms at 60 Hz, average ~8 ms) on top of the compositor.** A frame that finishes decoding 1 ms after a rAF tick waits ~15 ms doing nothing. **This is free latency for Swoop to reclaim:** render on the `VideoDecoder` output callback into a `desynchronized: true` canvas (or a WebGPU external texture), and use `requestVideoFrameCallback`/`expectedDisplayTime` for measurement rather than for scheduling.
- **[V]** libmatoya additionally runs a `requestAnimationFrame` loop purely to signal the WASM thread (`mty_signal(MTY.psync, true)`) — i.e. the app's own tick is vsync-driven.

### 1C.5 Input path in the browser (libmatoya, unminified)

- **[V] Mouse:** a plain `mousemove` listener on the canvas. When pointer-locked it sends `ev.movementX/movementY` (relative); otherwise `clientX/clientY` scaled by `devicePixelRatio`. The event is `postMessage`'d to the WASM worker **immediately on the event — not batched to rAF.**
- **[V] ⚠ No `getCoalescedEvents()`, no `pointerrawupdate`, no `unadjustedMovement: true` on `requestPointerLock()`.** So on a high-poll-rate mouse the client only sees one aggregated `mousemove` per browser frame, and relative deltas go through OS pointer acceleration. **[I] Both are cheap wins Swoop should take: `pointerrawupdate` + `getCoalescedEvents()` to recover sub-frame motion, and `requestPointerLock({unadjustedMovement: true})` to get raw deltas — which is what you actually want to hand to `SendInput`.**
- **[V] Keyboard:** `keydown`/`keyup` on `window`, sending **`ev.code`** (physical key, layout-independent — correct) plus `ev.key` and a packed modifier mask built from `shiftKey/ctrlKey/altKey/metaKey` + `getModifierState("CapsLock"/"NumLock")`. `preventDefault()` is called unless the combo is on an allow-list (Ctrl+V/C, Ctrl+Shift+I, Ctrl+R, F5, F11, F12, Ctrl+1..9) — i.e. a deliberate "keyboard grab" policy with browser-essential escapes preserved.
- **[V]** Pointer-lock exit via ESC is intercepted (`MTY.synthesizeEsc`) and a synthetic ESC keypress is forwarded to the host, because the browser swallows it. **[I] Nice detail — without it, ESC never reaches the remote machine.**
- **[V] Wheel:** quantised to ±120 per axis (classic `WHEEL_DELTA`), `{passive: true}`.
- **[V] Gamepads:** polled from a `setInterval(..., 10)` (100 Hz) and only while `document.hasFocus()`. Same interval also pushes window geometry.
- **[V]** `blur`/`focus` are forwarded to the host. **[I] This is where you hang "release all held keys" — see Part 1B.**

### 1C.5a Auth, as shipped (worth a security note)

**[V]** `weblib.js` reads and writes the session token from a cookie:
```js
// read
const name = 'parsec_login=';
const auth = JSON.parse(cookie.substring(name.length));
mty_str_to_c(auth['token'], session_id_c, size);
// write
const hostname = window.location.hostname.replace(/.*?\./, '');   // parent domain
document.cookie = 'parsec_login=' + JSON.stringify({token: session_id, userId: 0}) +
  ';domain=' + hostname + ';path=/;secure;max-age=31536000;samesite=strict;';
```
So: a **JSON session token in a non-HttpOnly cookie**, scoped to the **parent domain** (i.e. shared across all `*.parsec.app` subdomains), with a **1-year `max-age`**. It is `secure` and `samesite=strict`, and the console prints a self-XSS warning (*"STOP! ✋ This area is intended for developers…"*), which tells you they know.

**[I]** It has to be readable by JS because WASM needs it, so `HttpOnly` is off the table for this architecture — but the **1-year lifetime and parent-domain scope** are choices, not constraints. For Swoop inside Owlette: keep the viewer token **short-lived and per-session** (minutes, scoped to one machine), mint it from the existing Firebase auth, and scope the cookie/storage to the exact origin serving the viewer. A long-lived fleet-wide token in a JS-readable cookie is a much worse blast radius than a gaming product's.

### 1C.6 What Parsec's web client does NOT do (all verifiable by absence in the bundle)

| Missing | Consequence |
|---|---|
| TURN / relay in the browser ICE config | No connectivity behind CGNAT or symmetric NAT without paid Enterprise HPR |
| Unreliable/unordered data channel for video | SCTP head-of-line blocking on every lost packet |
| HEVC / AV1 / 10-bit / 4:4:4 in the browser | Browser guests get H.264 Baseline 4:2:0 only — ~2x the bitrate of HEVC for the same quality |
| `requestVideoFrameCallback`, `desynchronized`, WebGL/WebGPU video render | ~1 extra frame of presentation latency |
| Coalesced / raw pointer events, unadjusted movement | Mouse feel worse than native, capped at browser frame rate |
| Client-side RTT measurement (`networkLatency` is hardcoded 0) | No basis for adaptive buffering or congestion feedback from the browser |
| Firefox / Safari / iOS support | Chromium-only; macOS hosts cannot be joined from the web app at all |

**[I] Net read: Parsec's browser client is a 2018 architecture with a 2022-era decoder swap bolted on. The architecture (native core in WASM, DataChannel transport, host-side encoder shared with native clients) is right and worth copying. The five gaps in that table are precisely where a 2026 design beats it, and none of them are hard.**



## PART 2 — PEER SYSTEMS TEARDOWN

> Researched in a parallel stream on **2026-09-17**; all GitHub source read at repo HEAD that day unless a commit/PR date is given. Reproduced essentially verbatim because the value is in the numbers and the exact config strings. Its own "not verified" list is at the end of this Part.

All GitHub source read at repo HEAD on **2026-09-17** unless a commit/PR date is given. Everything below cites a URL; where I could not verify something I say so explicitly at the end.

---

### 0. The single most important find (read this first)

**`linckosz/moonlight-web` ("MoonlightWeb", GPLv3, C++/Qt)** is essentially Swoop already built, by one author (Bruno Martin), with a *published measurement campaign*. Native Windows/Linux/macOS host → browser, WebRTC, WebCodecs decode, H.264/HEVC/AV1, multi-viewer. It has design docs with click-to-photon numbers, an encoder bench with per-preset ms, and a documented transport ladder.

- Repo: https://github.com/linckosz/moonlight-web (README read 2026-09-17, version 0.2.4)
- Encoder bench (French): `docs/bench-native-host.md` — campaigns dated **04/09/2026, 06/09/2026, 07/09/2026**
- Transport chapter: `docs/wiki/05-Streaming-and-Transports.md`
- Client presentation bench: `docs/wiki/15-Client-Presentation-Benchmarks.md`

Headline claims (README, line 10): *"Under **20 ms** glass-to-glass over Wi-Fi on a LAN, ~**25 ms** over the Internet."*

**Architecture (README §Architecture):**
```
NATIVE ENGINE (default)              moonlight-common-c (paired hosts)
capture  DXGI · WGC                  RTSP / RTP / ENet → re-packetised
         KMS · ScreenCast            onto WebRTC
         ScreenCaptureKit
encode   NVENC · AMF · QSV
         VA-API · VideoToolbox
zero-copy: capture → encode → fragment → DTLS → browser
          (no loopback, no RTP, no FEC)
```
README line 59: *"on an RTX 5060 Ti at 1440p that is **0.06 ms** to acquire a frame and **3.46 ms** to encode it, with **one** memory copy per frame. Video decodes in **WebCodecs + WebGPU/canvas**, audio in **AudioWorklet**."*

### Its five transport modes and why (wiki ch.5 §5.1) — verbatim table
| Mode | Browser path | Video sink | Codecs | Notes |
|---|---|---|---|---|
| `webrtc-dc-udp` | video+input **SCTP DataChannels** + RTP audio track, UDP ICE | canvas (WebCodecs) | H.264/HEVC/AV1 | **Default. Lowest latency with full codec choice** |
| `webrtc-dc-tcp` | same, ICE-TCP candidates | canvas | H.264/HEVC/AV1 | UDP-hostile networks |
| `webrtc-media-udp` | RTP video+audio tracks, input DataChannel | `<video>` | **H.264 only** | browser-managed jitter/FEC/PLC; HDR-capable sink |
| `webrtc-media-tcp` | same, ICE-TCP | `<video>` | H.264 only | |
| `wss` | one WebSocket (TLS), all multiplexed | canvas | H.264/HEVC/AV1 | LAN-IP only; worst latency |

Fallback order (Enhancer off): `webrtc-dc-udp → webrtc-dc-tcp → webrtc-media-udp → webrtc-media-tcp → wss`.

### Engineering tricks worth stealing (wiki ch.5 §5.2, verbatim details)
- **DataChannel framing**: each access unit fragmented into DC messages carrying a `frameId`. Video DC is **ordered with `maxPacketLifeTime=500 ms`** ("a lifetime, not a retransmit count: a link freeze must not replay second-old frames ahead of the keyframe"). Frontend detects `frameId` gaps and **requests an IDR rather than reordering** — a frontend reorder buffer "was tried and removed — it causes IDR floods and latency."
- **IDR discipline**: backend throttles/coalesces IDR requests (**250–500 ms cooldown**, sticky `m_AwaitingIdr`), both sides use exponential backoff under congestion "otherwise mobile networks enter an IDR spiral."
- **Backpressure**: 256 KB DC high-watermark (keyframes exempt); frontend consults `VideoDecoder.decodeQueueSize` before `decode()`; WebGPU `draw()` awaits `onSubmittedWorkDone()`.
- **webrtc-media path only**: no browser PLI reaches the backend, so a **proactive IDR every 250 ms** runs until the client confirms; RTP timestamps derived from real capture times ("a synthetic 60 fps clock broke frame pacing"); `playoutDelayHint`/`jitterBufferTarget` set on the **`RTCRtpReceiver`** (not the element), driven adaptively by an AIMD `JitterController`; a non-zero target re-arms backend NACK.
- **DC/WebCodecs path has no dejitter buffer at all** — presents on decode, drops to freshest frame. Opt-in `FramePacer` (`mw_pacing=1`) rebuilds a reserve from `backendTs` capture stamps: tracks minimum transit delay, sizes reserve at **p95 of per-frame excess**, **hard cap 25 ms** ("past ~1.5 frames the added lag hurts a shooter more than the judder it removes"). A buggy version "pinned the reserve at the 25 ms cap on every non-loopback link (24.6 ms held against a 2.9 ms measured tail)."
- **Audio is always a real RTP Opus track, never a DataChannel** — "the ordered audio DataChannel this replaced head-of-line-blocked on packet loss (periodic ~0.5 s dropouts); the browser's NetEq conceals the loss instead." SDP must carry `stereo=1;sprop-stereo=1` or "libwebrtc instantiates a **mono** decoder and downmixes (L+R)/2 — ~6 dB quieter." RTP timestamps advance by the negotiated Opus frame size, "never by arrival time — an arrival-time clock makes NetEq time-stretch and the audio turns robotic."
- Native host audio: WASAPI loopback on an MMCSS "Pro Audio" thread → `AudioPacer` (exactly one 5 ms frame every 5 ms) → libopus 1.5.2 restricted-low-delay (CELT), **128 kbps constrained VBR**. Measured: 200 packets/s, 0 drops, NetEq holds ~32 ms.

### THE browser gotcha — H.264 SPS `bitstream_restriction` (bench §6, measured 2026-09-04)
Measured decode latency, real stream, Chrome, `webrtc-dc-udp`, 1440p60 40 Mbit/s:

| Codec | decode ms (avg/p99) | render | host total | **displayed latency** |
|---|---|---|---|---|
| HEVC `hvc1.1.144.L150` | 1.1 / 2.5 | 0.6 / 2.4 | 6.8 | **9.2 ms** |
| AV1 | 0.9 / 2.4 | 0.4 / 0.8 | 5.5 | **7.4 ms** |
| H.264 `avc1.640033` **before fix** | **200.8 / 206.3** | 0.4 / 1.4 | 6.3 | **208 ms** |
| H.264 **after fix** | 0.9 / 2.7 | 0.4 / 0.8 | 6.1 | **8.3 ms** |

Cause (quoted, translated): the NVENC SPS carried no `bitstream_restriction`; without `max_num_reorder_frames` **Chrome's D3D11 H.264 decoder holds a whole DPB before displaying — about a dozen frames at 1440p60, on a stream with no B-frames at all.** Fix: `h264VUIParameters.bitstreamRestrictionFlag = 1`. HEVC already carries it by default. **208 → 8 ms.** This is in `NvencEncoder.cpp` with the comment verbatim.

### Its NVENC config (backend/native-host/src/encode/windows/NvencEncoder.cpp, read 2026-09-17)
- `kDefaultPreset = 1` (**P1**), `NV_ENC_TUNING_INFO_ULTRA_LOW_LATENCY`
- `gopLength = NVENC_INFINITE_GOPLENGTH`; `frameIntervalP = 1` (no B-frames — "one would make the encoder hold a frame back… buying a whole frame of latency")
- `rateControlMode = NV_ENC_PARAMS_RC_CBR`, `averageBitRate == maxBitRate`
- `vbvBufferSize = vbvBits(bitrate, fps, m_VbvFrames)` with `vbvInitialDelay = vbvBufferSize`; **VBV has a 1/60 s floor** (RateControl.h) — with a strict 1-frame VBV at 165 Hz the first keyframe came out at QP 50
- `repeatSPSPPS = 1`, `idrPeriod = INFINITE`
- **DPB = 4 frames** (`kDpbFrames = 4`) with `numRefL0 = 1` — "Four frames of DPB let up to three consecutive lost frames be healed by an ordinary delta… the encode time is unchanged (measured: within noise at P1)"
- Intra-refresh only on request; period/count are **durations (~2 s worth)**, not frame counts
- 4:4:4 needs the profile GUID set explicitly (`NV_ENC_H264_PROFILE_HIGH_444_GUID` / `NV_ENC_HEVC_PROFILE_FREXT_GUID`) — "Without this NVENC accepts 4:4:4 input and encodes 4:2:0 from it"

### Its measured preset numbers (bench §2/§3/§6b, RTX 5060 Ti, 1440p, CBR 40 Mbit/s)
Call of Duty 1440p60 (the target content):
| Setting | encode ms avg/p95/p99 | KB/frame | QP |
|---|---|---|---|
| P4/ULL (old default) | **7.67** / 10.24 / 11.26 | 29.5 | **25** |
| P1 | **3.40** / 4.61 / 5.12 | 29.5 | **25** |
| P1, multipass off | 2.62 / 4.10 / 4.61 | 29.0 | 25 |
| P4, AV1 | 5.39 / 7.17 / 7.68 | 28.2 | q 91 |
| P1, H.264 | 4.07 / 5.63 / 6.14 | 29.5 | 27 |
| P4 @ 20 Mbit/s | 7.36 | 14.8 | 31 |
| P1 @ 20 Mbit/s | 3.08 | 14.8 | 32 |

Verdicts: **P1 costs nothing in QP on game content** (25 vs 25). Scrolling text costs +5 QP at P1 (sharp high-contrast edges P4 predicts better). **Keep the ULL preset's quarter-res multipass**: turning it off saves 0.4–0.6 ms but *breaks the still-screen refinement burst* — single-pass RC on a picture that just stopped moving never spends its budget and **QP stalls at 29 instead of reaching 8**. Temporal AQ does nothing. AMF pre-analysis **kills the encoder session**. Intel `LowPower`/VDENC: HEVC 1080p60 **16.3 → 10.5 ms**, 1440p **21.4 → 13.4 ms**. oneVPL has **no reference-frame invalidation** (`NumRefFrame = 1`) and its bitrate **cannot be raised above the init value** (`Reset` refuses).

### Its client-presentation numbers (wiki ch.15, Sept 2026, Chrome 152, RTX 5060 Ti)
- **`<video>` is the slowest presenter everywhere, by 35–45 ms** — "it presents on the compositor's vsync and behind the generator's own queue." Windowed SDR click-to-photon: Canvas2D 54.4 ms median vs **`<video>` sink 90.0 ms**.
- Fullscreen click-to-photon 720p→1440p: Canvas2D Off 30.3 / p90 36.8; NIS-WebGPU 26.8 / 36.6; FSR1-WebGL2 34.6 / 41.2. **Hierarchy inverts between windowed and fullscreen** — WebGPU wins fullscreen by 5–10 ms.
- Default shipped: **Canvas2D on the main thread**, enhancer off, video worker off ("WebGPU-in-worker is the macOS pathology" — 22.8 ms of Handoff on macOS Chrome 126).
- **HDR on a canvas is broken in Chrome**: `importExternalTexture` (WebGPU) and `drawImage` (Canvas2D) tone-map PQ→SDR *on import*. Only `VideoFrame.copyTo()` of raw planes preserves it, and `copyTo` works on **software-decoded frames only** — Chrome has software AV1 (dav1d), no software HEVC. True HDR on canvas ⇒ AV1 software decode, ~**+10 ms**. True HDR with HEVC ⇒ `<video>` element.
- **HEVC 4:4:4 10-bit (`hvc1.4.156`) decodes in hardware but renders GREEN** in `<video>` and Canvas2D alike on Chrome 152/Windows. 8-bit 4:4:4 (`hvc1.4.158`) is fine. Their decision: **4:4:4 is SDR-only, HDR stays 4:2:0.**
- NVENC does 4:4:4 for H.264 and HEVC, **never AV1**. AMF and oneVPL do no 4:4:4 at all.

**The second browser project**, `MrCreativ3001/moonlight-web-stream` (Rust, v2.10.0 stable / v3 dev), is the original. It relays Sunshine's access units onto **real RTP tracks** via `libdatachannel`-style `rtc` crate, H.264/HEVC/AV1 payloaders, and **stamps `PlayoutDelayExtension { min_delay: 0, max_delay: 0 }` on every single RTP packet** (`src/api/stream/webrtc/video.rs`). RTCP feedback advertised: `nack`, `nack pli`, `goog-remb`. It also allocates an `RTCRtpFecParameters` SSRC. Browser decodes via `VideoDecoder` (WebCodecs), with an openh264-js WASM fallback for non-secure contexts.

**`moonlight-chrome` is dead** — NaCl-based, **archived 2025-06-04**, maintainers redirect to Android/Qt. https://github.com/moonlight-stream/moonlight-chrome

---

### 1. Sunshine / Moonlight

### 1.1 Capture (Windows)
`src/platform/windows/display_base.cpp`, `display_wgc.cpp` (HEAD 2026-09-17):
- Default `capture = ddx` — **DXGI Desktop Duplication** via `IDXGIOutputDuplication`. Prefers `DuplicateOutput1()` with an explicit supported-format list, falls back to `DuplicateOutput()`. `dxgi->SetMaximumFrameLatency(1)`.
- `wgc` (**Windows.Graphics.Capture**, beta) — `Direct3D11CaptureFramePool::CreateFreeThreaded(..., 2, item.Size())` (2 buffers), `IsBorderRequired(false)`, and critically **`capture_session.MinUpdateInterval(4ms)` = 250 Hz** — without it "Screen capture may be capped to 60fps on this device for this release of Windows." **WGC is not compatible with the Sunshine service.** (docs: https://docs.lizardbyte.dev/projects/sunshine/latest/md_docs_2configuration.html)
- No NvFBC in current Sunshine on Windows (NvFBC is a Linux-only legacy path; not present in the Windows tree I read).

### 1.2 Frame pacing — "frame pacing groups"
`display_base_t::capture()` runs a two-mode loop: once a frame arrives it establishes a *pacing group* anchored at `img_out->frame_timestamp` and thereafter sleeps to `group_start + n/fps` and calls `snapshot(..., 0ms, ...)` with a **zero timeout**; if the group is missed it falls back to `snapshot(..., 200ms, ...)` to re-anchor. `adjust_client_frame_rate()` snaps capture rate to the display's exact rational refresh when it's within 1% ("Can only decrease requested fps, otherwise client may start accumulating frames and suffer increased latency"). Client sends `clientRefreshRateX100`.
There is an explicit comment about DD's global critical section: holding `AcquireNextFrame()` starves the encoder, so the timeout logic exists to release it.

### 1.3 NVENC (Sunshine's own NVENC impl, `src/nvenc/nvenc_base.cpp`)
```cpp
init_params.presetGUID   = quality_preset_guid_from_number(config.quality_preset); // default 1 → P1
init_params.tuningInfo   = NV_ENC_TUNING_INFO_ULTRA_LOW_LATENCY;
init_params.enablePTD    = 1;

enc_config.gopLength                  = NVENC_INFINITE_GOPLENGTH;
enc_config.frameIntervalP             = 1;                     // no B-frames
enc_config.rcParams.rateControlMode   = NV_ENC_PARAMS_RC_CBR;
enc_config.rcParams.zeroReorderDelay  = 1;
enc_config.rcParams.enableLookahead   = 0;                     // rc_lookahead OFF
enc_config.rcParams.lowDelayKeyFrameScale = 1;
enc_config.rcParams.multiPass         = NV_ENC_TWO_PASS_QUARTER_RESOLUTION;  // default
enc_config.rcParams.averageBitRate    = client_config.bitrate * 1000;
enc_config.rcParams.vbvBufferSize     = bitrate*1000 / framerate;  // 1 frame, + nvenc_vbv_increase%
```
Per-codec:
```cpp
format_config.repeatSPSPPS   = 1;
format_config.idrPeriod      = NVENC_INFINITE_GOPLENGTH;
format_config.sliceMode      = 3;                       // slices per frame
format_config.sliceModeData  = client_config.slicesPerFrame;
// H.264: profileGUID = yuv444 ? NV_ENC_H264_PROFILE_HIGH_444_GUID : ..._HIGH_GUID; chromaFormatIDC = 3
// default ref frames: 5 for H.264/HEVC, 8 for AV1; but numRefL0 = NV_ENC_NUM_REF_FRAMES_1
//   "Limit each frame to one reference while keeping a larger DPB for RFI fallback."
```
**Intra-refresh** (only when the client asks, `client_config.enableIntraRefresh == 1`):
```cpp
format_config.enableIntraRefresh   = 1;
format_config.intraRefreshPeriod   = 300;
format_config.intraRefreshCnt      = 299;
format_config.outputRecoveryPointSEI = 1;              // PR #5091, 2026-05-09
format_config.singleSliceIntraRefresh = 1;             // if NV_ENC_CAPS_SINGLE_SLICE_INTRA_REFRESH
```
**Split-frame encoding** (`configure_split_frame`, NVENC SDK ≥ 13.0, PR #4892 merged 2026-03-23; earlier PR #3061 2024-08-22 went stale):
```cpp
if (config.split_frame_encoding == disabled)          NV_ENC_SPLIT_DISABLE_MODE;
else if (... == force_enabled)                        NV_ENC_SPLIT_AUTO_FORCED_MODE;
else                                                  NV_ENC_SPLIT_AUTO_MODE;   // default driver_decides
```
Requires `NV_ENC_CAPS_NUM_ENCODER_ENGINES > 1` (Ada 4070 Ti+ with 2+ NVENC blocks). Log suffixes `sfe-auto` / `sfe`.

**Reference-frame invalidation**: `encoder_params.rfi = get_encoder_cap(..., NV_ENC_CAPS_SUPPORT_REF_PIC_INVALIDATION)`; disabled if the GPU can't do multiple ref frames.

### 1.4 FFmpeg-path encoder options (`src/video.cpp`)
```cpp
// NVENC legacy (ffmpeg):   {"delay",0} {"forced-idr",1} {"zerolatency",1} {"surfaces",1}
//                          {"preset", nv_legacy.preset /* "p1".."p7" */}
//                          {"tune", NV_ENC_TUNING_INFO_ULTRA_LOW_LATENCY} {"rc", NV_ENC_PARAMS_RC_CBR}
// QSV:                     {"preset", qsv_preset} {"forced_idr",1} {"async_depth",1} {"low_delay_brc",1}
// AMF:                     {"filler_data",false} {"forced_idr",1} {"async_depth",1}
//                          {"quality", amd_quality_*} {"rc", amd_rc_*} {"usage", amd_usage_*}
//                          {"max_au_size", amd_max_au_size}
//                          Vulkan/other AMF path: {"usage", 2 /* AMF_VIDEO_ENCODER_USAGE_LOW_LATENCY */}
// VA-API:                  {"async_depth",1} {"idr_interval", INT_MAX}
// libx264/x265 (software): preset default "superfast", tune default "zerolatency",
//                          {"x265-params","info=0:keyint=-1"}
// SVT-AV1:                 {"svtav1-params","keyint=-1:pred-struct=1:force-key-frames=1:mbr=0"}
```
Universal:
```cpp
ctx->max_b_frames = 0;                                // "B-frames delay decoder output, so never use them"
ctx->gop_size = INT_MAX; ctx->keyint_min = INT_MAX;   // infinite GOP, IDR on demand
  // except FIXED_GOP_SIZE encoders (Media Foundation): gop_size = keyint_min = 120
ctx->flags  |= AV_CODEC_FLAG_CLOSED_GOP | AV_CODEC_FLAG_LOW_DELAY;
ctx->flags2 |= AV_CODEC_FLAG2_FAST;
ctx->slices = max(config.slicesPerFrame, config::video.min_threads);   // min_threads default 2
ctx->thread_type = FF_THREAD_SLICE; ctx->thread_count = ctx->slices;
ctx->rc_max_rate = bitrate; ctx->bit_rate = bitrate;
ctx->rc_buffer_size = bitrate / framerate;            // 1 frame VBV (software+slices: /( fps*10/15 ))
```

### 1.5 Config defaults (docs, retrieved 2026-09-17)
`nvenc_preset=1` (P1) · `nvenc_twopass=quarter_res` · `nvenc_spatial_aq=disabled` · `nvenc_vbv_increase=0` (0–400) · `nvenc_split_encode=driver_decides` · `nvenc_latency_over_power=enabled` · `amd_usage=ultralowlatency` · `amd_rc=vbr_latency` · `amd_quality=balanced` · `amd_vbaq=enabled` · `qsv_preset=medium` · **`fec_percentage=20`** (1–255) · `min_threads=2` · `qp=28` · `max_bitrate=0` (use Moonlight's request).

### 1.6 Transport — GameStream protocol as Sunshine implements it (`src/stream.cpp`)
- **Control channel: ENet**, `ENET_PACKET_FLAG_RELIABLE` on channel 0, encrypted with AES-GCM (`control_encrypted_t`). Moonlight derives RTT from ENet stats (`LiGetEstimatedRttInfo`).
- **Video: raw RTP-ish over UDP.** Header written by hand: `inspect->rtp.header = 0x80 | FLAG_EXTENSION;` **90 kHz clock**, timestamp = capture time:
  ```cpp
  using rtp_tick = std::chrono::duration<uint32_t, std::ratio<1, 90000>>;
  uint32_t timestamp = std::chrono::round<rtp_tick>(*packet->frame_timestamp - video_epoch).count();
  ```
- **Host processing latency** is carried in the `video_short_frame_header_t` (headerType 0x01), field `frame_processing_latency`, **units of 1/10 ms**, clamped to uint16:
  ```cpp
  return (uint16_t) std::clamp((duration_us + 50) / 100, 0, UINT16_MAX);
  ```
  Moonlight reads it as `DECODE_UNIT.frameHostProcessingLatency` ("Optional host processing latency of the frame, in 1/10 ms units. Zero when the host doesn't provide the latency data or frame processing latency is not applicable (happens when the frame is repeated)"). *This is a Sunshine frame header extension, not a standard RTP header extension.*
- **Frame type** field: `2` = IDR, `5` = after reference-frame invalidation, `1` = normal P.
- **FEC: Reed–Solomon** (`reed_solomon_new(data_shards, parity_shards)`, `reed_solomon_encode`).
  ```cpp
  parity_shards = (data_shards * fecpercentage + 99) / 100;
  if (parity_shards < minparityshards && fecpercentage != 0) {   // minRequiredFecPackets from client = 2
      parity_shards  = minparityshards;
      fecpercentage  = (100 * parity_shards) / data_shards;      // can exceed 100% for tiny frames
  }
  ```
  - `blocksize = packetsize + MAX_RTP_HEADER_SIZE`; Moonlight's default `packetSize = 1024`, capped at 1024 for remote streams.
  - **Max 4 FEC blocks per frame** (2 bits in the header). `max_data_shards_per_fec_block = (255 * 100) / (100 + fecPercentage)` — derived from `D = 255/(1+F)`.
  - If more than 4 blocks are needed, **FEC is disabled for that frame** ("For normal FEC percentages, this should only happen for enormous frames (over 800 packets at 20%)").
  - 10-bit FEC packet index ⇒ a frame over 4096 packets is unrecoverable (logged as an error).
  - `fecInfo = (x << 12) | (data_shards << 22) | (percentage << 4)`.
- **Per-frame packet rate control** in the sender:
  ```cpp
  // Use around 80% of 1Gbps
  size_t ratecontrol_packets_in_1ms = 1e9 * 80/100 / 1000 / blocksize / 8;
  size_t send_batch_size = min<size_t>(64, 64*1024 / blocksize);
  // "On Windows, batches above 64K seem to bypass SO_SNDBUF regardless of its size,
  //  appear in 'Other I/O' and begin waiting for interrupts."
  // (also: Linux GSO can't do more than 64)
  ```
  Socket `send_buffer_size(1024*1024)`.
- **Video payload encryption** optional: AES-GCM per shard, deterministic IV per NIST SP 800-38D §8.2.1, `iv[11]='V'`.

### 1.7 Moonlight client negotiation (`moonlight-common-c`, HEAD)
`SdpGenerator.c`, verbatim attributes:
```
x-nv-vqos[0].fec.enable                 = 1      // "FEC must be enabled for proper packet sequencing"
x-nv-vqos[0].fec.minRequiredFecPackets  = 2
x-nv-vqos[0].fec.repairPercent          = 20     // 5 when streaming 4K "to reduce stream overhead"
x-nv-vqos[0].bllFec.enable              = 0      // BLL-FEC gives "single digit percentages for many large frames"
x-nv-vqos[0].videoQosMaxConsecutiveDrops = 0     // for [0]..[3]
x-nv-vqos[0].videoQualityScoreUpdateTime = 5000
x-nv-video[0].packetSize                = StreamConfig.packetSize   (1024 default, %16==0)
x-nv-video[0].videoEncoderSlicesPerFrame = CAPABILITY_SLICES_PER_FRAME(x) or 1
x-nv-video[0].maxNumReferenceFrames     = 0 if decoder supports RFI, else 1
x-nv-video[0].clientRefreshRateX100     = <hz*100>
x-ml-video.configuredBitrateKbps        = <bitrate>       // Sunshine-only, for dynamic FEC
adjustedBitrate = bitrate * 0.80                          // "20% of the video bitrate added for FEC"
```
Sunshine's side (`src/rtsp.cpp`): advertises `a=x-nv-video[0].refPicInvalidation:1`, and parses `x-ss-video[0].chromaSamplingType` and `x-ss-video[0].intraRefresh`.

Client RTP queue (`VideoStream.c`):
```c
#define RTP_QUEUE_DELAY 10           // ms the RTP queue waits for missing/reordered packets
#define RTP_RECV_PACKETS_BUFFERED 2048
```

### 1.8 Codec / 4:4:4 support (`Limelight.h`)
```c
VIDEO_FORMAT_H264            0x0001   VIDEO_FORMAT_H264_HIGH8_444  0x0004
VIDEO_FORMAT_H265            0x0100   VIDEO_FORMAT_H265_MAIN10     0x0200
VIDEO_FORMAT_H265_REXT8_444  0x0400   VIDEO_FORMAT_H265_REXT10_444 0x0800
VIDEO_FORMAT_AV1_MAIN8       0x1000   VIDEO_FORMAT_AV1_MAIN10      0x2000
VIDEO_FORMAT_AV1_HIGH8_444   0x4000   VIDEO_FORMAT_AV1_HIGH10_444  0x8000
VIDEO_FORMAT_MASK_YUV444     0xCC04
CAPABILITY_REFERENCE_FRAME_INVALIDATION_AVC/HEVC/AV1  0x2 / 0x4 / 0x40
CAPABILITY_DIRECT_SUBMIT 0x1   CAPABILITY_PULL_RENDERER 0x20
```
Linux NVENC 4:4:4 landed in PR #4965 (merged **2026-04-09**); PRs #5570 (2026-08-29) and #5691 (2026-09-11) still open for exact 4:4:4 / HEVC RExt profile selection.

### 1.9 Moonlight's latency overlay (moonlight-qt `app/streaming/video/ffmpeg.cpp`, HEAD) — exact fields
```
Video stream: %dx%d %.2f FPS (Codec: %s)
Incoming frame rate from network: %.2f FPS
Decoding frame rate: %.2f FPS
Rendering frame rate: %.2f FPS
Host processing latency min/max/average: %.1f/%.1f/%.1f ms     // stats/10, from frameHostProcessingLatency
Frames dropped by your network connection: %.2f%%
Frames dropped due to network jitter: %.2f%%
Average network latency: %u ms (variance: %u ms)               // ENet RTT
Average decoding time: %.2f ms
Average frame queue delay: %.2f ms
Average rendering time (including monitor V-sync latency): %.2f ms
```

---

### 2. RustDesk

- **Capture**: DXGI (Windows), X11 + Wayland/PipeWire (Linux), Quartz (macOS). Frames arrive as `PixelBuffer` (sysmem) or `Texture` (GPU-resident). — https://deepwiki.com/rustdesk/rustdesk/5.1-video-capture-and-encoding (retrieved 2026-09-17)
- **Codecs**: VP8, VP9, AV1 (software: `VpxEncoder`/libvpx, `AomEncoder`/libaom), H.264/H.265 hardware (`HwRamEncoder` = FFmpeg+sysmem, `VRamEncoder` = direct GPU texture, NVENC/AMF). Negotiation via `Encoder::update`, which **aggregates capabilities from all connected peers**; priority **HW H265/H264 → AV1 → VP9 → VP8**.
- **Transport**: its own protocol — clients connect outward to an ID/rendezvous server which brokers P2P or a relayed session; end-to-end encrypted with NaCl. Not WebRTC, not QUIC. — https://rustdesk.com/blog/rustdesk-vs-vnc/
- **The architectural latency problem**: `VideoFrameController` implements **acknowledgement-based backpressure** — frames are sent with a connection ID, the host **waits via `try_wait_next` for client acknowledgement**, and the capture→encode cycle blocks until delivery is confirmed. That is a per-frame round trip in the capture loop. `VideoQoS::check_qos` then adjusts `spf` (seconds per frame) and quality.
- **Observed slowness** — https://github.com/rustdesk/rustdesk/discussions/6888 (opened 2024-01-15): sub-10 ms network RTT, yet <5 fps controlling mobile, ≤15 fps desktop scrolling, "significant delay and frame loss"; bitrate capped ~600 KB/s regardless of config. Collaborator `21pages` attributed the cap to **AV1-specific bitrate limits**; switching to VP8/VP9 "improves smoothness and response time significantly." Later comment (mahergreg, 2025-04) added Windows DPI scaling as a factor.
- VRAM→software fallback when GPU encode produces consistently bad frames (`same_bad_len_counter`).
- **Not verified**: any published glass-to-glass number for RustDesk. I found none.

---

### 3. Selkies (formerly selkies-gstreamer)

**Big architectural news: Selkies 2.0 dropped GStreamer *and* made WebSockets the default transport.**
https://github.com/selkies-project/selkies/releases — **2.0.0rc0, published 2026-09-12**, verbatim:

> "GStreamer is gone from the runtime: screen capture and video encoding are done by `pixelflux`, audio capture and encoding by `pcmflux`, two Rust extensions that install with the wheel."
> "**WebSockets is the default transport.** One TCP port (`8080` by default) carries video, audio, input, clipboard and file transfers, **decoded in the browser through WebCodecs**, with a striped JPEG path for browsers that have none. Nothing about it needs STUN or TURN."
> "**WebRTC is opt-in** (`--mode=webrtc`) on a vendored `aiortc` fork, and can be confined to a port range, to one shared UDP and/or TCP port, or run ICE-lite for a restrictive firewall. `--enable-dual-mode=true` lets the page switch transports while the session runs."
> Known limitation: "H.265/HEVC and AV1 are planned in `pixelflux`; this release encodes **H.264 and Motion JPEG**."

1039 commits between v1.6.2 (2024-08-15) and the 2.0.0rc0 build commit (2026-09-12).

**The WebRTC tuning work (1.x era)** — https://github.com/selkies-project/selkies-gstreamer/issues/157 "[META] Optimize the WebRTC stack to the maximum", **opened 2024-05-25**, closed by PR #254 (opened 2026-06-13, **merged 2026-07-14**):
- `playout-delay` RTP header extension marked **MUST**, send zero values.
- **Explicit warning against** setting `jitterBufferTarget` / `jitterBufferDelayHint` / `playoutDelayHint` to zero: *"causes stutter if the buffer wants to be bigger, but it's constantly forced down to 0 (most notably in higher resolutions)."*
- Wanted extensions: `abs-send-time`, `video-timing`, `playout-delay`, `transport-cc` feedback; transport-wide CC for video **and** audio when GCC is active.
- NACK + PLI for video; **RTX with `rtx-time=125`** for H.264.
- SDP: `b=AS:300000`, `x-google-max-bitrate=300000`; `a=rtcp-mux`, `a=group:BUNDLE`; max DataChannel message 262,144 bytes.

In current source (`src/selkies/webrtc_engine.py`, HEAD 2026-09-17) the SDP munging is still there:
```python
sdp_text = re.sub(r'(apt=\d+)', r'\1;rtx-time=125', sdp_text)      # inject rtx-time
# also: sps-pps-idr-in-keyframe=1 for H.264/H.265
```
Codec names in the engine: `h264enc`, `h264enc-striped`, `h265enc`, `vp9enc`, `av1enc`.

- **Not verified**: I found **no published glass-to-glass latency number** for Selkies, in either the release notes or issue #157.

---

### 4. neko (m1k1o/neko)

- Go server, X11/`ximagesrc` capture + PulseAudio, GStreamer encode, **Pion** WebRTC, Vue.js client that plays a `MediaStream` in a `<video>` element. Binary DataChannel for input.
- Exact default pipelines — `server/pkg/types/codec/codecs.go` (HEAD 2026-09-17):
```
VP8  (PT 96):  vp8enc cpu-used=16 threads=4 deadline=1 error-resilient=partitions
               keyframe-max-dist=15 static-threshold=20
VP9  (PT 98):  vp9enc cpu-used=16 threads=4 deadline=1 keyframe-max-dist=15 static-threshold=20
H264 (PT 102): video/x-raw,format=I420 ! x264enc threads=4 bitrate=4096 key-int-max=15
               byte-stream=true tune=zerolatency speed-preset=veryfast
               ! video/x-h264,stream-format=byte-stream
H265 (PT 116): x265enc bitrate=4096 key-int-max=60 tune=zerolatency speed-preset=veryfast
               option-string="vbv-maxrate=4096:vbv-bufsize=4096" ! video/x-h265,...,profile=main
AV1  (PT 96):  av1enc target-bitrate=4096 cpu-used=4 end-usage=cbr undershoot=95
               keyframe-max-dist=15 min-quantizer=4 max-quantizer=20
Opus (PT 111): opusenc inband-fec=true bitrate=128000
```
NVENC (docs, https://neko.m1k1o.net/docs/v3/configuration/capture): `nvautogpuh264enc name=encoder preset=2 gop-size=25 spatial-aq=true temporal-aq=true bitrate=4096 vbv-buffer-size=4096 rc-mode=6` (older: `nvh264enc preset=low-latency-hq gop-size=25 … rc-mode=6`).
- Latency claim in their own docs: **"Ultra-low latency streaming (<300ms)"** — an order of magnitude looser than Moonlight-class.
- The instructive bug: **PR #673** (created **2026-07-31**, merged **2026-08-04**, fixes issue #598 "High latency ~10 seconds after connecting"). Browser audio jitter buffer ratcheted to ~10 s because Go scheduler hiccups delivered buffered frames in bursts. Fix broke the backpressure chain: `Track.sample` channel buffered to 2 with non-blocking `WriteSample`, `pipeline.sample` buffered to 4, GStreamer audio queue `leaky=downstream max-size-buffers=5`, **`appsink sync=false`**, and releasing `listenersMu` before dispatch. https://github.com/m1k1o/neko/pull/673
- **Searched and found nothing**: neko has **no** `playout-delay`, `playoutDelayHint` or `jitterBufferTarget` handling anywhere in the repo (GitHub code search, 2026-09-17). That is a concrete gap vs JetKVM/Selkies/MoonlightWeb.

---

### 5. Chrome Remote Desktop

- **WebRTC, definitively.** https://chromium.googlesource.com/chromium/src/+/main/remoting/docs/architecture.md: *"CRD currently uses WebRTC for communication between the host and the client. There is obsolete code in our code base for a communication protocol called Chromotocol, which was used by deprecated non-website clients, which will soon be deleted."*
- **Codecs** (`remoting/protocol/webrtc_video_encoder_wrapper.cc`, HEAD): VP8, VP9 (profile 0 = I420, **profile 1 = I444 "lossless color"**), AV1 (profile 0/1, same lossless-color split), H.264 — but H.264 is compiled only `#if defined(USE_H264_ENCODER)` and the factory advertises it only if `WebrtcVideoEncoderGpu::IsSupportedByH264({{1920,1080},30})`. `GetSupportedFormats()` returns **only** `"H264"` when present; VP8/VP9/AV1 come from libwebrtc's built-ins.
- **VPX settings** (`remoting/codec/webrtc_video_encoder_vpx.cc`, HEAD) — this is the whole reason CRD feels the way it does:
```cpp
config->g_lag_in_frames   = 0;            // "Start emitting packets immediately"
config->kf_min_dist = config->kf_max_dist = 10000;   // "Since the transport layer is reliable,
                                          //  keyframes should not be necessary" (10k = crbug 440223 workaround)
config->rc_dropframe_thresh = 0;          // "Do not drop any frames at encoder"
config->rc_end_usage      = VPX_CBR;      // "We do not want variations in bandwidth"
config->rc_undershoot_pct = 100;  config->rc_overshoot_pct = 15;
// VP8: g_profile = 2 (real-time); Linux threads capped at 2 (4 if >=16 cores) — crbug 1151148
// VP9: kVp9DefaultEncoderSpeed = 6, kVp9MaxEncoderSpeed = 9, kVp9LosslessEncodeSpeed = 5
//      VP9E_SET_AQ_MODE = 3 (cyclic refresh)
// encode deadline: VPX_DL_REALTIME
kVp8MinimumTargetBitrateKbpsPerMegapixel = 2500
```
  **The key architectural fact: CRD assumes a reliable transport and effectively never sends keyframes.** That is why it recovers badly from loss and why it is tuned for desktop, not motion.
- **Frame scheduler** (`webrtc_frame_scheduler_constant_rate.cc`): constant-rate capture timer; `capture_interval_ = max(Hertz(max_fps) - post_task_adjustment_, 1ms)` where `post_task_adjustment_` is **2 ms on machines with ≥16 cores, 0 otherwise** ("We've observed the encoding rate in the client as being a couple of frames lower than the target"). `max_framerate_fps_` clamped to 1000. There is a `BoostCaptureRate(interval, duration)` path clamped to ≥1 ms.
- Multi-process on Windows: SYSTEM daemon (mojo broker) + LOCAL_SERVICE network process + SYSTEM desktop process that does the capture; all Mojo IPC.
- **Not verified**: any published CRD latency number from Google. I found none.

---

### 6. Steam Remote Play

This is the weakest section — Valve publishes almost nothing technical.
- https://store.steampowered.com/remoteplay (retrieved 2026-09-17), verbatim: *"real-time video encoding over a custom low-latency network protocol"*; *"video and audio are sent from your gaming PC to another device… all within milliseconds."* Remote Play Together: *"up to four players — or even more with fast connections."* No codec, no transport, no numbers.
- **Steam Datagram Relay** — https://partner.steamgames.com/doc/features/multiplayer/steamdatagramrelay: *"Valve's virtual private gaming network."* Relays hide IPs (DoS protection), all traffic "authenticated, encrypted, and rate-limited", PoPs identified by 3–4 char codes, and *"for a surprisingly high number of players, we can also find a faster route through our network, which actually improves player ping times."* **No quantified latency figures on that page.**
- **GameNetworkingSockets** (the open-source core) — https://github.com/ValveSoftware/GameNetworkingSockets: message-oriented, connection-oriented transport over UDP; reliability uses an **ack-vector model from DCCP (RFC 4340) and Google QUIC**; **AES-GCM-256 per packet**, Curve25519 for key exchange/cert signatures, key derivation and per-packet IV following Google QUIC; head-of-line-blocking control and bandwidth sharing across multiple message "lanes" on one connection via priority / weighted fair queueing. SDR access is Steamworks-only.
- **Could NOT verify**: Steam Remote Play's codec (H.264 vs HEVC vs AV1), capture method, encoder settings, its performance-overlay field names, any published latency number, and **whether a Steam Link *browser* client exists at all**. The device list on store.steampowered.com/remoteplay is native apps only (iOS/tvOS/visionOS, Android/Android TV, Fire TV, Raspberry Pi 3/3+/4/5, Windows/Linux/macOS, Meta Quest 2/3/Pro). Steam Support and Steam News pages are JS-rendered and returned only navigation chrome to both WebFetch and curl. **Treat any Steam Remote Play codec claim as unverified.**

---

### 7. GeForce NOW

**Transport, measured** — arXiv **2401.06366v2**, "Network Anatomy and Real-Time Measurement of Nvidia GeForce NOW Cloud Gaming", **2024-01-12**, https://arxiv.org/html/2401.06366v2:
| | Native app | Browser |
|---|---|---|
| Management | TCP **322** | TCP **49100** (WebRTC signalling) |
| User input | UDP **49003** | single combined UDP flow |
| Audio down/up | UDP **49004** / **49005** | (same flow) |
| Video down | UDP **49006** | (same flow) |
| Protocol | **RTP over UDP** (no standard session establishment) | **WebRTC** |

- Peak downstream video: FHD 60 fps **23–35 Mbps**, FHD 30 fps 15–22; HD 60 fps 15–21, HD 30 fps 9–13; SD ≤13 / ≤8.
- Downstream audio constant **37 kbps @ 300 pps**; upstream audio **15 kbps @ 100 pps**; user input **1–82 kbps**.
- Video packets: full data packets **1,466 bytes**, frame-marker packets **216 bytes**.
- **Client-side latency, wired: app-based under 20 ms ~90% of the time; browser-based under 20 ms ~70% of the time.** (That ~20-point gap is the cost of the browser.)
- Earlier paper arXiv **2012.06774** (2020-12-12) measured GFN at **H.264 only**, 720p/1080p median 15/20 Mbps with peaks >40, "considerably more variable" bitrate vs Stadia's constant; RTT 15–20 ms from their vantage point.

**NVIDIA's own claims** (https://www.nvidia.com/en-us/geforce-now/faq/ and /system-reqs/, retrieved 2026-09-17):
- Browser (Chrome 77+, Edge 91+, Firefox 153+, Opera GX 117+, Safari 16.4+): **15 Mbps → 720p60, 25 Mbps → 1080p60, 35 Mbps → 1440p120** (Ultimate required for 1440p/120).
- Native/Ultimate: 65 Mbps → 5120×2180 @120 fps; 55 Mbps → 1440p/1600p @240 fps; **48 Mbps → 1080p @360 fps** ("competitive gaming mode"); 45 Mbps → 4K @120; 25 Mbps → FHD @60; **100 Mbps recommended for "Cinematic Quality Streaming"**.
- Network requirement: *"less than 80ms of network latency from an NVIDIA data center."*
- **Could NOT verify on nvidia.com**: a "Cloud G-SYNC" page, a Reflex-on-GFN blog post, or any official click-to-pixel millisecond figure. Wikipedia (https://en.wikipedia.org/wiki/GeForce_Now, secondary) attributes to NVIDIA: AV1 ≈40% bitrate saving vs H.264; CQS = YUV **4:4:4** + 10-bit HDR at up to 100 Mbit/s; Cloud G-SYNC on Ultimate; RTX 5080 servers "**sub-30 millisecond click-to-pixel latency**". **Flag that 30 ms number as secondary-sourced.**

---

### 8. Xbox Cloud Gaming (browser)

- **WebRTC, H.264 only.** Best primary evidence is the reverse-engineered client `unknownskl/xbox-xcloud-player` (196 stars, updated **2026-08-29**), described as *"a library that can connect to an xCloud / xHome stream using WebRTC."*
- `src/player.ts`: `addTransceiver('audio', {direction:'sendrecv'})`, `addTransceiver('video', {direction:'recvonly'})` + `setCodecPreferences(...)`; the track is attached to a `<video>` element (`VideoComponent`) — i.e. browser-managed decode and jitter buffer, no WebCodecs.
- `src/lib/sdp.ts` `getDefaultCodecPreferences()` orders codecs: **H.264 `profile-level-id=4d*` (Main) first, then `42e*` (Constrained Baseline), then `420*` (Baseline)**; `ulpfec`, `flexfec`, VP9 and VP8 are all pushed to the bottom tier. Bitrate is set by SDP munging (`b=` line) for video and audio; stereo enabled by rewriting `useinbandfec=1` → `useinbandfec=1; stereo=1`.
- arXiv 2401.06366v2 says its methods generalise to Xbox Cloud Gaming "with platform-specific signatures obtained from training traffic traces", i.e. the same TCP-management + RTP-media flow structure — but **gives no separate Xbox bitrate, packet-size, or latency numbers** in the main text (Appendix 0.B was not retrievable through the HTML render). **Xbox measured latency: NOT verified.**

---

### 9. Google Stadia and the WebRTC extensions Google built

### 9.1 Measured Stadia behaviour
arXiv **2009.09786** ("Cloud-gaming: Analysis of Google Stadia traffic", v1 **2020-09-21**, v2 2022-05-23; journal: Computer Communications 188 (2022) 99–116), read via https://ar5iv.labs.arxiv.org/html/2009.09786:
- **RTP/RTCP over UDP inside WebRTC, DTLS-encrypted, ICE/STUN/TURN.** One UDP flow carrying multiple RTP streams distinguished by SSRC.
- Codecs **VP9 and H.264**; Opus audio ~120 kbps. H.264 produced *lower* load than VP9 for the same game (23.63 vs 27.56 Mbps, Tomb Raider).
- Bitrates: 720p ~9/15/19 Mbps (min/median/max); 1080p ~20/28/32; 4K ~30/40/43.74. A 2D platformer ran at 0.64/1.5/6.56.
- Video RTP packets 1,050–1,200 bytes (mode 1,194 at 1080p); inter-packet time <1 ms for >80% of packets; **6 packet groups per frame separated by ~2 ms**; 60 fps (16.67 ms period). Audio ~360 B @ 20 ms. STUN ~81 B every ~265 ms.
- **RTT 10–15 ms average, p95 <25 ms; up to 35 ms peaks under a 10 Mbps cap.**
- **Jitter buffer delay: 720p 58.42 ms (3.5 frames), 1080p 45.35 ms (2.7 frames), 4K 35.35 ms (2.1 frames).** — note this is the *default* WebRTC jitter buffer even in Stadia's own client, and it dwarfs everything else in the chain.
- Adaptation: holds 1080p60 far below the nominal bandwidth requirement, drops to 720p "as last resort" around 20 Mbps. Recovery from a sudden drop takes **47–287 s** (a drop to 15 Mbps caused a 287-second transient; a drop to 10 Mbps caused 12 resolution changes over 95 s, with framerate falling to 5–10 fps and audio stuttering). Bandwidth *increases* recover in seconds. At sustained RTT >70 ms for >6 minutes the session is terminated.
- vs conferencing: **Stadia needs ~6–10× the RTP throughput** of Google Meet/Jitsi at 720p.
- Comparative paper arXiv 2012.06774 (2020-12-12): Stadia holds a constant bitrate; no resolution reduction at 1–5% packet loss, 10% loss forces 720p.

### 9.2 The extensions themselves (primary specs, read from the libwebrtc docs tree)
**`playout-delay`** — https://github.com/webrtc-sdk/webrtc/blob/main/docs/native-code/rtp-hdrext/playout-delay/README.md (mirror of `webrtc.googlesource.com/src/+/HEAD/docs/native-code/rtp-hdrext/playout-delay/README.md`), verbatim:
- URI `http://www.webrtc.org/experiments/rtp-hdrext/playout-delay`, SDP name `playout-delay`. Status: experimental, "we intend to make a proposal based on it for standardization in the IETF."
- Explicitly names the use case: *"**Interactive streaming (gaming, remote access)**: Interactive streaming is highly sensitive to end-to-end latency… In these cases, the RTP sender would like to disable all smoothing at receiver (**min delay = max delay = 0**)."*
- Wire format: `| ID | len=2 | MIN delay (12 bits) | MAX delay (12 bits) |` — 3 bytes of data, **10 ms granularity**, range 0–40,950 ms.
- `Playout delay = ExpectedRenderTime(frame) − ExpectedCaptureTime(frame)`.
- Sender MAY stop sending it once RTCP confirms a packet carrying it was received (compare the highest received sequence number against the sequence number of the first packet carrying the current values).

**`abs-capture-time`** — URI `http://www.webrtc.org/experiments/rtp-hdrext/abs-capture-time`. 1-byte header + 8 bytes (short) or 16 bytes (extended, adds estimated capture clock offset). NTP timestamp of when the first frame in the packet was captured, 64-bit unsigned fixed-point (32.32). "A capture system SHOULD have known delays (e.g. from hardware buffers) subtracted from the readout." Contact `chxg@google.com`.

**`video-timing`** — URI `…/rtp-hdrext/video-timing`. 1-byte extension, 13 bytes of data (14 total). Flags byte (0x01 = set by timer, 0x02 = frame larger than usual) then **six 16-bit ms deltas from capture time**: encode start, encode finish, packetization complete, last packet left the pacer, + 2 reserved for in-network processors. The pacer updates its own timestamp *inside the packet* on the way out. Contact `ilnik@google.com`. (Chromium mirrors this as `VideoSendTiming` in `api/video/video_timing.h`.)

**`video-layers-allocation00`** — URI `…/rtp-hdrext/video-layers-allocation00`. Per-layer target bitrate (leb128), resolution and framerate so an SFU can pick a layer without decoding. Relevant to Swoop only if you ever simulcast to multiple viewers.

**`RTCRtpReceiver.jitterBufferTarget`** — Chrome Platform Status feature 5930772496384000: created 2024-02-11 by `eldar.rello@gmail.com`, **"Enabled by default" from Chrome 124** on desktop, Android, WebView and iOS; tracking bug https://issues.chromium.org/issues/324276557. MDN (https://developer.mozilla.org/en-US/docs/Web/API/RTCRtpReceiver/jitterBufferTarget): `DOMHighResTimeStamp`, **milliseconds, 0–4000**, `RangeError` outside; it *influences* rather than sets the target (the UA keeps it within its own min/max); if audio and video are synchronised the **larger** of the two receivers' values is used for both. Measure with `RTCInboundRtpStreamStats.jitterBufferTargetDelay / jitterBufferEmittedCount` vs `jitterBufferMinimumDelay`. Marked "Limited availability" (not Baseline).
  - Note the Selkies warning above: forcing it to 0 at high resolutions causes stutter. The sender-side `playout-delay` extension is the stronger lever (see JetKVM below).
- **Could NOT verify**: "negative latency" as a Stadia-specific published technique, or any Google engineering blog post about it. I found no primary source. **Treat "Stadia negative latency" as unverified.**

---

### 10. Amazon DCV (formerly NICE DCV) with QUIC

Primary: Amazon DCV Administrator Guide and User Guide PDFs (https://docs.aws.amazon.com/pdfs/dcv/latest/adminguide/dcv-ag.pdf, `…/userguide/dcv-ug.pdf`, retrieved 2026-09-17; the HTML pages are JS-only).
- Admin Guide, verbatim: *"By default, **since version 2024.0**, Amazon DCV supports both the WebSocket protocol, which is based on TCP, and the QUIC protocol, which is based on UDP for data transport. The QUIC transport protocol is based on UDP. **If your network experiences high latency and packet loss, using QUIC might improve performance.** With QUIC, the server continues to use WebSocket for authentication traffic."*
- Config: `enable-quic-frontend` (registry on Windows, `[connectivity]` in `dcv.conf` on Linux), `quic-port`, `quic-listen-endpoints`.
- User Guide: the native client defaults to QUIC when available, falls back to WebSocket. QUIC requires *"direct client-server communication where there are **no intermediate proxies, gateways, or load balancers**."* When QUIC is active, `"QUIC"` appears in the client titlebar.
- **The line that matters for Swoop**, User Guide verbatim: ***"The web browser client doesn't support the QUIC (UDP) transport protocol."*** DCV's browser client is WebSocket/TCP only. The QUIC feature matrix also shows macOS DCV server does not support QUIC.
- **Could NOT verify**: any AWS-published latency measurement or percentage improvement for QUIC vs WebSocket. The docs say "might improve performance" and nothing more.

---

### 11. Jump Desktop Fluid

Very thin. https://jumpdesktop.com/ (retrieved 2026-09-17), verbatim: *"Powered by the proprietary **Fluid 2.0 protocol**, delivering unmatched speed and responsiveness"*; supports **"4:4:4 10 bit color"** for "crisp text and vibrant images"; Surround Sound.
- **Could NOT verify**: codec, transport (UDP/TCP/QUIC), hardware encoder, any latency or fps number. `jumpdesktop.com/features/` is 404 and `support.jumpdesktop.com` returned 403 to WebFetch and a "page doesn't exist" to curl for every article ID I tried. Their support site appears to have been reorganised. **Everything about Fluid beyond the two quoted marketing claims is unverified.** Note the 4:4:4 10-bit claim is interesting given MoonlightWeb measured HEVC 4:4:4 10-bit rendering *green* in Chrome — Jump ships native clients, not a browser client, so it doesn't hit that wall.

---

### 12. JetKVM — hardware, pipeline, and precisely why it is slow

### Hardware
- **SoC: Rockchip RV1106.** Confirmed from https://github.com/jetkvm/rv1106-system (`sysdrv/source/uboot/u-boot/configs/rv1106_defconfig`: `CONFIG_ROCKCHIP_RV1106=y`; the whole BSP is Rockchip's IPC/RV1106 tree). Low-power Cortex-A7 IPC-class SoC with the Rockchip MPP VENC block.
- **HDMI capture chip: Toshiba TC358743XBG** (HDMI→CSI-2 bridge), stated by the maintainer in PR #1452 (2026-05-08): *"The capture chip is the **Toshiba TC358743XBG** (vendor-modified `tc35874x` driver in the BSP). Its datasheet specifies 'Video Formats Support (Up to 1080P @60fps)' and characterizes the chip only at 60 Hz."* That is the 120 Hz ceiling on v1 hardware.

### Capture path
`internal/native/cgo/video.c` (HEAD 2026-09-17): V4L2 on `/dev/video0`, `V4L2_BUF_TYPE_VIDEO_CAPTURE_MPLANE`, **`V4L2_PIX_FMT_YUYV`** (4:2:2 packed), **`V4L2_MEMORY_DMABUF`**, **3 buffers** (`input_buffer_count = 3`), Rockchip MB pool with `MB_ALLOC_TYPE_DMA`. So capture itself is zero-copy DMA-BUF into the VENC — that part is fine.

### Encoder — this is the problem
```c
RK_U32 min_bitrate = bitrate / 2;
// "GOP scales with framerate so IDR cadence stays ~0.5s regardless of source refresh"
RK_U32 gop = fps > 0 ? fps / 2 : 30;

stAttr->stRcAttr.enRcMode = VENC_RC_MODE_H264VBR;        // or H265VBR
stAttr->stRcAttr.stH264Vbr.u32BitRate    = bitrate;
stAttr->stRcAttr.stH264Vbr.u32MaxBitRate = max_bitrate;
stAttr->stRcAttr.stH264Vbr.u32MinBitRate = min_bitrate;
stAttr->stRcAttr.stH264Vbr.u32Gop        = gop;          // ~0.5 s
stAttr->stRcAttr.stH264Vbr.u32StatTime   = 2;            // 2-second RC statistics window
stAttr->stVencAttr.enType        = RK_VIDEO_ID_AVC;
stAttr->stVencAttr.enPixelFormat = RK_FMT_YUV422_YUYV;
stAttr->stVencAttr.u32Profile    = H264E_PROFILE_HIGH;   // H265E_PROFILE_MAIN for HEVC
stAttr->stVencAttr.u32StreamBufCnt = 3;
```
Bitrate ladder (`calculate_bitrate`): `base_bitrate_low = 512`, `base_bitrate_high = 4000` kbps (was **2000** until the 2026 rework), scaled by `pixels / (1920*1080)`, floor 200 kbps. **So "High" quality at 1080p is 4 Mbps of VBR H.264 High profile.**

**Why it's slow / soft, concretely:**
1. **VBR with a 2-second statistics window**, not CBR-with-1-frame-VBV. Rate control reacts on a 2 s horizon, so a burst of motion overshoots and the frames that overshoot take multiple frame-times to get on the wire.
2. **A real IDR every ~0.5 s** rather than infinite GOP + on-demand IDR + intra-refresh. Every IDR is a bitrate spike on a 4 Mbps budget; on a congested link the spike causes the loss that causes the next IDR.
3. **Very low bitrate ceiling** (4 Mbps at 1080p) — Sunshine/Moonlight default is 20 Mbps and MoonlightWeb benches at 40.
4. **No hardware headroom**: the RV1106 is an IPC SoC; the TC358743XBG is a 1080p60 part.
5. Until recently, **no auto rate adaptation at all** — `Add Auto video quality using RTCP REMB` is **issue #1633, opened 2026-09-17, still open**.
6. `internal/native/cgo/video.c` also sets `RK_ALIGN_16` virtual width/height (was `RK_ALIGN_2`, fixed in PR #1347) and limited-range BT.709/BT.601 VUI (PR #1460, 2026-05-13) — both were correctness bugs, not latency ones, but they show how young the pipeline is.

### Their own measurements (PR #1372, "feat(video): tune encoder for better quality and faster recovery", **2026-03-29**)
Sweep across quality factor, random terminal output, fresh WebRTC session per factor, 3 s stabilisation, 5 s measurement:

| factor | target | actual | fps | dropped | decode | freezes | **jitter** |
|---|---|---|---|---|---|---|---|
| 0.10 | 861 kb | 3359 kb | 60 | 0 | 4.5 ms | 0 | **29.5 ms** |
| 0.50 | 2256 kb | 6305 kb | 60 | 0 | 5.1 ms | 0 | **48.4 ms** |
| 1.00 | 4000 kb | 9190 kb | 61 | 0 | 5.8 ms | 0 | **119.0 ms** |

(baseline before the change was worse: 51.3 / 84.1 / **135.2 ms**). The changes were GOP 60→30, `u32MinBitRate = target/2`, `u32StatTime` 3→2, bitrate floor 100→200 kbps. Note **actual bitrate is 2.3× the target** — the VBR controller is not tracking. AVBR "crashes the RV1106 SDK"; QP constraints "flatten all quality levels to the same bitrate."

**That jitter column is the answer to "why is JetKVM slow": 30–119 ms of receiver buffering, growing with bitrate.** Decode is 3–6 ms; capture+encode is not the bottleneck.

### The fix they shipped, and it is the single best trick in this whole report
`internal/playoutdelay/interceptor.go`, added in **PR #1475, merged 2026-05-22** — a Pion interceptor. Header comment verbatim:

> *"Chrome's adaptive jitter buffer is one-way: it grows when packet timing gets jittery (e.g. the JetKVM H.264 encoder emitting variable-size frames during high-motion content like fullscreen YouTube on the host) and **stubbornly refuses to shrink back**, leaving the 'Playback Delay' graph stuck at hundreds of milliseconds until the page is reloaded. **Receiver-side knobs like jitterBufferTarget / playoutDelayHint / setMinimumJitterBufferDelay all cap the steady-state floor but cannot pull a ratcheted buffer back down.** The playout-delay extension is the sender-side counterpart… Chrome honours it as an **authoritative override** of its adaptive logic. We send min=max=0 on every video packet, which keeps the receiver pinned at the absolute floor."*

```go
const URI = "http://www.webrtc.org/experiments/rtp-hdrext/playout-delay"
func NewFactory() *Factory { return &Factory{MinDelay10ms: 0, MaxDelay10ms: 0} }
// encode packs the 3-byte body: 12 bits MIN, 12 bits MAX, big-endian.
func encode(min, max uint16) []byte {
    min12, max12 := min&0x0FFF, max&0x0FFF
    return []byte{byte(min12 >> 4), byte(min12<<4) | byte(max12>>8), byte(max12)}
}
```
Applied to **every** outgoing RTP packet in `BindLocalStream`, no-op if the extension wasn't negotiated in SDP.

### Other JetKVM facts
- Transport: **Pion WebRTC v4** (`webrtc.go` imports `github.com/pion/ice/v4`, `pion/webrtc/v4`; dependabot PR #1112 bumped it 4.1.6→4.2.1 on 2026-01-01). `TrackLocalStaticSample` for video and audio. Codec picked by sniffing the browser's offer SDP for `H265` (`browserSupportsH265 := strings.Contains(strings.ToUpper(offerSDP), "H265")`), falling back to H.264. `SetICEMulticastDNSMode`, `SetICEAddressRewriteRules` for LAN srflx candidates, cloud-provided STUN/TURN.
- H.265 added in PR #1371 (2026-03-29) but **disabled on Linux browsers** in PR #1435 (2026-04-30, "avoid undecodable streams").
- 120 Hz support (PR #1452, 2026-05-08): `1280x720@120` added to the default EDID **as base-block DTD1, not in the CTA extension**, because *"NVIDIA's display driver enumerates base-block DTDs reliably but ignores DTDs in the CTA-861 extension that don't carry a CTA VIC."* Measured result, verbatim: *"Glass-to-glass latency on the source-capture leg drops from ~16.7 ms (60 fps) to ~8.3 ms (120 fps)… with `inbound-rtp.framesPerSecond ≈ 120` sustained on a clean LAN."*
- Official marketing claim (https://jetkvm.com/ and the docs repo `content/docs/index.mdx`): *"1080p@60FPS video with **30-60ms latency** using H.264 encoding."*
- **Could NOT verify**: any *independent* third-party latency measurement of JetKVM. Everything above is the vendor's own instrumentation. Their `ui/e2e` suite exists but publishes no numbers.

---

### Cross-cutting conclusions for Swoop

1. **Sender-side `playout-delay` min=max=0 is mandatory, not optional.** It is the only lever that *overrides* Chrome's ratcheting jitter buffer; `jitterBufferTarget`/`playoutDelayHint` only set a floor. (JetKVM interceptor comment, 2026-05-22; webrtc.org spec names gaming/remote-access as the motivating use case; Selkies issue #157 calls it a MUST.) But heed Selkies' counter-warning: a hard 0 target on the *receiver* side causes stutter at high resolutions. Sender extension yes; receiver `jitterBufferTarget=0` no.
2. **If you send over an RTP media track into `<video>`, you have already lost 35–45 ms** to the compositor and generator queue (MoonlightWeb ch.15, measured, Sept 2026). The fastest browser path measured anywhere in this survey is **WebRTC DataChannel (SCTP/DTLS) carrying access units → WebCodecs `VideoDecoder` → Canvas2D**, with audio on a real RTP Opus track. That is MoonlightWeb's default and Selkies 2.0's default-by-another-route.
3. **Set `bitstreamRestrictionFlag = 1` in the H.264 SPS VUI.** Without it, Chrome's D3D11 H.264 decoder holds a full DPB: measured **208 ms → 8 ms**. HEVC carries it by default. This alone would sink a naive Swoop H.264 implementation.
4. **HEVC and AV1 both decode in ~1 ms in Chrome on modern hardware** (MoonlightWeb §6). Codec choice can be made on host encode cost and licensing, not client decode. But: **HEVC 4:4:4 10-bit renders green** on Chrome/Windows, and **HDR on a canvas requires software AV1 decode** (+~10 ms) because `importExternalTexture`/`drawImage` tone-map PQ on import.
5. **NVENC: P1 + ULL tuning + CBR + infinite GOP + no B-frames + 1-frame VBV (with a 1/60 s floor) + `repeatSPSPPS=1` + DPB 4 / refL0 1 for RFI.** Keep the ULL preset's quarter-res multipass. Both Sunshine and MoonlightWeb converged on essentially the same config independently; MoonlightWeb has the measurements proving P1 costs nothing in QP on game content (3.4 ms vs 7.7 ms at identical QP 25).
6. **Multi-viewer**: MoonlightWeb caps at 4 simultaneous (owner + 3) and **pins the quality ladder while a guest is connected** ("the automatic ladder would relaunch your stream on the other slot to shave a few megabits, which on a jittery network means transitioning more than streaming"). Selkies enforces input authority server-side per viewer role/slot. Both are worth copying.
7. **The IDR spiral is a real failure mode.** Throttle/coalesce IDR requests (250–500 ms cooldown) with exponential backoff on both ends, and prefer intra-refresh over periodic keyframes.
8. **Frame pacing is a trap.** MoonlightWeb ships its pacer **opt-in** and hard-caps the reserve at 25 ms, and documents a shipped bug where the reserve pinned at 24.6 ms against a 2.9 ms measured tail. Freshest-frame-first is the default for a reason.

---

### Explicitly NOT verified

- **Steam Remote Play**: codec, capture method, encoder settings, performance-overlay field names, any latency figure, and the existence of any browser/web Steam Link client. Valve's pages are JS-rendered and I could not get past the navigation chrome with WebFetch or curl.
- **Xbox Cloud Gaming**: any measured latency or bitrate number. Transport (WebRTC) and codec (H.264, Main preferred) are solid from the reverse-engineered client; the arXiv appendix with Xbox traffic detail did not render.
- **GeForce NOW**: the "sub-30 ms click-to-pixel", "Cloud G-SYNC", Reflex-on-GFN and CQS-4:4:4 claims are **Wikipedia-sourced (secondary)**. I could not find the corresponding NVIDIA primary pages; nvidia.com's GFN blog URLs I tried all 404'd and their FAQ has no G-SYNC or millisecond text.
- **Stadia "negative latency"**: no primary source found. Do not cite it.
- **Amazon DCV QUIC**: no AWS-published latency measurement exists in the admin or user guide — only "might improve performance."
- **Jump Desktop Fluid**: everything except "Fluid 2.0 protocol" and "4:4:4 10 bit color". Their support site is 403/404 for article URLs.
- **Selkies**: no published glass-to-glass number, in either 1.x or 2.0.
- **RustDesk**: no published glass-to-glass number.
- **Chrome Remote Desktop**: no Google-published latency number.
- **JetKVM**: no independent third-party latency measurement; all figures are the vendor's own instrumentation.
- My WebSearch budget was exhausted early (200/200), so sections 6, 7, 11 lean on direct URL guessing; a follow-up pass with search available would most likely close the Steam and Jump Desktop gaps.

**Scratchpad artifacts** (source files downloaded, if you want to re-read any of them):
`<local scratchpad>\swoop-research\raw\` — contains `nvenc_base.cpp`, `stream.cpp`, `video.cpp`, `display_base.cpp`, `display_wgc.cpp`, `Limelight.h`, `SdpGenerator.c`, `VideoStream.c`, `RtpVideoQueue.c`, `ffmpeg.cpp`, `crd_vpx.cc`, `crd_webrtc_video_encoder_wrapper.cc`, `jetkvm_video_new.c`, `jetkvm_playoutdelay.go`, `mw_nvenc.cpp`, `mw_bench.md`, `mw_transports.md`, `mw_ch15.md`, `neko_codecs.go`, `mws_video.rs`, `xcloud_sdp.ts`, `dcv-ag.txt`, `dcv-ug.txt`. Nothing in the Owlette repo was modified.


---

## PART 3A — BROWSER PLATFORM FACTS I VERIFIED DIRECTLY (Chrome Platform Status API, queried 2026-09-17)

Source for this table: the Chrome Platform Status API (`https://chromestatus.com/api/v0/features?q=<term>` and `/features/<id>`), which is Google's own feature-shipping record, queried live on **2026-09-17**. Safari/Firefox columns are those projects' recorded standards positions, not a substitute for a compat table.

| Feature | Chrome (desktop) | Safari | Firefox | Notes |
|---|---|---|---|---|
| **HEVC/H.265 in WebRTC** (`RTCPeerConnection`) | **Enabled by default, M136** (desktop, Android, WebView; **iOS: null**) | **Shipped/Shipping** | No signal | Chrome bug crbug.com/391903235 |
| **HEVC hardware decode** (media pipeline) | **Enabled by default, M107** | Shipped/Shipping | **Negative** (bugzilla 1332136) | *"Android 5.0+, macOS 11+, with supported hardware on Windows 8+ and ChromeOS"* |
| **HEVC in WebCodecs** | **M130** (per the WebRTC feature's own summary) | Shipping | — | |
| **HEVC in MediaRecorder** | M136 | No signal | No signal | |
| `RTCRtpReceiver.jitterBufferTarget` | **Enabled by default, M124** (desktop/Android/WebView/**iOS 124**) | No signal | **Shipped/Shipping** | Spec: https://w3c.github.io/webrtc-extensions/#dom-rtcrtpreceiver-jitterbuffertarget (published standard) |
| `HTMLVideoElement.requestVideoFrameCallback()` | Enabled by default, **M83** | No signal (but MDN records it as **Baseline since Oct 2024**) | Positive | |
| AV1 decode | Enabled by default, **M70** | No signal | Shipped/Shipping | |
| AV1 encode | Enabled by default, M90 | No signal | Positive | |
| WebRTC SVC extensions (scalability modes) | Enabled by default, **M111** | No signal | No signal | Relevant to multi-viewer |
| Per-frame quantizer in `VideoEncoder` | Enabled by default, M117 | Positive | Neutral | |
| Transferable `RTCDataChannel` to dedicated workers | **In developer trial (behind a flag), M130** | **Shipped/Shipping** | No signal | Would let the video data channel live off the main thread |
| Manual reference frame control in `VideoEncoder` | **Proposed** (not shipped) | No signal | No signal | Encoder-side; not needed if you encode natively |
| Expose `rtpTimestamp` on `VideoFrame.metadata()` | Proposed, M145 | No signal | No signal | |

### Verbatim quotes worth keeping

**HEVC in WebRTC** (Chrome Platform Status feature 5153479456456704, status M136):
> *"HEVC is already an industry standard and we should support it in WebRTC when provided by the platform, i.e., **if it is available in hardware (we will not provide a software implementation)**. The codec is already available in **WebCodecs (M130)** and MediaRecorder APIs (M136). After this change, HEVC will join VP8, H.264, VP9, and AV1 as supported codecs in WebRTC. Support will be queryable via MediaCapabilities API. **Safari has already shipped support**."*

**`jitterBufferTarget`** (Chrome Platform Status, status M124):
> *"JitterBufferTarget attribute allows applications to specify a target duration of time in milliseconds of media for the RTCRtpReceiver's jitter buffer to hold. This influences the amount of buffering done by the user agent, which in turn **affects retransmissions and packet loss recovery**. Altering the target value allows applications to control the tradeoff between playout delay and the risk of running out of audio or video frames due to network jitter."*

**`VideoDecoderConfig.optimizeForLatency`** (MDN, https://developer.mozilla.org/en-US/docs/Web/API/VideoDecoder/configure):
> *"If `true` this is a hint that the selected decoder should be optimized to **minimize the number of `EncodedVideoChunk` objects that have to be decoded before a `VideoFrame` is output**."*
`hardwareAcceleration` takes `"no-preference" | "prefer-hardware" | "prefer-software"`. MDN flags WebCodecs as *"Limited availability… not Baseline because it does not work in some of the most widely-used browsers."*

**`requestVideoFrameCallback` metadata** (MDN, https://developer.mozilla.org/en-US/docs/Web/API/HTMLVideoElement/requestVideoFrameCallback — Baseline 2024, newly available since **October 2024**):
- `presentationTime` — *"the time when the browser submitted the frame for composition"*
- `expectedDisplayTime` — *"the time when the browser expects the frame to be visible"*
- `presentedFrames` — *"can be used to detect whether frames were missed between callback instances"*
- `processingDuration` — *"the duration between the submission of the encoded packet … to the decoder … and the decoded frame being ready for presentation"*
- `captureTime`, `receiveTime`, `rtpTimestamp` — WebRTC-only; `receiveTime` is *"the time when the last packet belonging to this frame was received over the network"*

### Cross-browser support, from the official Web Platform Status API (api.webstatus.dev, queried 2026-09-17)

`api.webstatus.dev` is the W3C/Google web-platform dashboard backed by browser-compat-data; versions below are first-supporting version @ release date.

| Feature | Chrome | Edge | Firefox | **Safari** | Safari iOS | Baseline |
|---|---|---|---|---|---|---|
| **WebCodecs** | 94 @2021-09-21 | 94 @2021-09-24 | 130 @2024-09-03 | **26 @2025-09-15** | **26 @2025-09-15** | limited |
| `requestVideoFrameCallback()` | 83 @2020-05-19 | 83 @2020-05-21 | 132 @2024-10-29 | **15.4 @2022-03-14** | 15.4 @2022-03-14 | **newly, 2024-10-29** |
| **Desynchronized 2D canvas** | 81 @2020-04-07 | 79 @2020-01-15 | — (no support) | **15 @2021-09-20** | 15 @2021-09-20 | limited |
| Desynchronized WebGL / WebGL2 canvas | 81 | 79 | — | — | — | limited |
| **WebTransport** | 97 @2022-01-04 | 97 @2022-01-06 | 114 @2023-06-06 | **26.4 @2026-03-24** | 26.4 @2026-03-24 | **newly, 2026-03-24** |
| Pointer Lock | 37 @2014-08-26 | 13 | 50 @2016-11-15 | 10.1 @2017-03-27 | — | limited |
| WebRTC SCTP info (`RTCSctpTransport`) | 76 @2019-07-30 | 79 | 113 @2023-05-09 | 15.4 @2022-03-14 | 15.4 | **widely, 2023-05-09** |
| WebRTC Encoded Transform | 141 @2025-09-30 | 141 @2025-10-03 | 117 @2023-08-29 | 15.4 @2022-03-14 | 15.4 | newly, 2025-10-03 |
| WebGPU | 144 @2026-01-13 | 144 @2026-01-21 | — | **26 @2025-09-15** | 26 @2025-09-15 | limited |
| Gamepad API | 35 @2014-05-20 | 12 | 29 | 10.1 @2017-03-27 | 10.3 | **widely, 2017-03-27** |

**[V] The headline: WebCodecs shipped in Safari 26 and Safari iOS 26 on 2025-09-15.** That is the fact that invalidates Parsec's "Chromium only" architecture. A DataChannel + WebCodecs design in 2026 can cover **Chrome, Edge, Firefox (130+), Safari 26+ on macOS, and Safari 26+ on iOS/iPadOS** — a strictly larger surface than Parsec's web client reaches today.

**⚠ Nuance that makes this even better news — reconciling two sources.** webstatus.dev dates "WebCodecs" (the whole feature) at Safari 26, but MDN's raw browser-compat-data dates **`VideoDecoder` itself at Safari 16.4** (Chrome 94, Firefox 130). The reconciliation: **Safari 16.4–18.7 shipped only the *video* interfaces** — `VideoDecoder`, `VideoEncoder`, `EncodedVideoChunk`, `VideoFrame` — with no audio or image classes; *full* WebCodecs landed in Safari 26.0. **[I] Since Swoop only needs the video interfaces on the client (audio can ride an RTP Opus track — see 5.3e), the practical Safari floor is 16.4 (March 2023), not 26.** That is a much wider install base. Verify empirically before committing; the Safari half of this is partly secondary-sourced because webkit.org was unreachable during this research.

**[V] Caveat worth flagging:** `desynchronized` is **not supported in Firefox at all**, and `desynchronized` WebGL/WebGL2 is **Chromium-only**. So the lowest-latency present path (`desynchronized: true` 2D canvas) covers Chromium + Safari but not Firefox; Firefox falls back to the normal compositor path and eats the extra frame.

**[V] `pointerrawupdate` and `getCoalescedEvents()` returned no entry in the webstatus feature set** — I could not verify their cross-browser support from a primary dashboard. Treat them as progressive enhancement behind feature detection, not as load-bearing. *(Unverified — flagged.)*

### Bitstream format rules — why Annex B is the right choice for a live desktop stream

**[V]** W3C WebCodecs **AVC** codec registration, Group Note Draft **8 June 2026**, https://www.w3.org/TR/webcodecs-avc-codec-registration/:
- Codec string prefix `avc1.` or `avc3.` + 6 hex chars (RFC 6381).
- *"When description is present … it is assumed to be an `AVCDecoderConfigurationRecord` … and the bitstream is assumed to be in **avc** format."*
- *"When description is absent … the bitstream is assumed to be **annexb** format,"* where *"SPS and PPS data are included periodically throughout the bitstream."*
- `EncodedVideoChunk` data *"is expected to be an access unit as defined in [ITU-T-REC-H.264] section 7.4.1.2."*

**[V]** W3C WebCodecs **HEVC** codec registration, Group Note Draft **8 June 2026**, https://www.w3.org/TR/webcodecs-hevc-codec-registration/:
- Codec string prefix `hev1.` or `hvc1.` + four dot-separated fields.
- *"If the description is present, it is assumed to be an `HEVCDecoderConfigurationRecord`"*; *"if the description is not present, the bitstream is assumed to be in **annexb** format."*
- Annex B *"is commonly used in live-streaming applications, where including the VPS, SPS, and PPS data periodically allows users to easily start from the middle of the stream."*
- Chunk data must be an access unit per H.265 §7.4.2.4.

**[I]** This is exactly why Parsec passes no `description` and hardcodes `avc1.42001e`: with Annex B you can hand the browser the raw NVENC output, repeat VPS/SPS/PPS on every intra-refresh cycle or IDR, and **a late-joining viewer can start decoding without any out-of-band setup handshake**. For multi-viewer that property is worth a lot — viewer N+1 joins mid-stream, gets parameter sets from the bitstream, and starts. Keep the stream Annex B; do not re-box to MP4/AVCC.

**[I] What this means for Swoop's codec decision.**
1. **H.265 to a browser is now genuinely available** — WebCodecs since Chrome 130 and WebRTC since Chrome 136, and Safari ships both. But it is **hardware-only by Chrome policy**, so an old client GPU means no HEVC at all rather than a slow HEVC — you must negotiate and fall back to H.264 per-viewer.
2. **Firefox is a hard no on HEVC** ("Negative" standards position). If Firefox is in scope, H.264 is the floor, and AV1 (Firefox shipped decode) is the only modern alternative — but AV1 *hardware* decode is far from universal on fleet-adjacent client hardware.
3. **iOS is the sharpest edge:** the HEVC-in-WebRTC feature record has `ios: null`. Parsec simply does not support iOS/iPadOS in the web app at all. Decide early whether iPad viewers are in scope; if they are, H.264 Baseline is your compatibility floor and Safari/VideoToolbox is your decode path.
4. **`jitterBufferTarget` (Chrome 124+, Firefox shipped, Safari absent) is the escape hatch *if* you use a media track.** It is not available in Safari, which is another argument for the DataChannel + WebCodecs path where you own the buffer outright and every browser behaves the same.



## PART 3B — BROWSER TRANSPORT AND DECODE PATH, FROM CHROMIUM/LIBWEBRTC SOURCE

> Researched in a parallel stream on **2026-09-17**, largely by reading Chromium and libwebrtc `main` directly. Reproduced essentially verbatim; the value is in the exact source constants. Its own conflict/unverified list is at the end of this Part.

All source fetches done 2026-09-17. Chromium/WebRTC source quotes are from `main` as of that date (GitHub mirrors `chromium/chromium` and `webrtc-mirror/webrtc`, since `chromium.googlesource.com` / `webrtc.googlesource.com` were 503-ing).

**Headline finding first:** the single highest-leverage thing Swoop can do on a WebRTC media track is have the **native host emit the `playout-delay` RTP header extension with `min=0, max>0 (≤500 ms)`**. That one bit flips *two* independent latency mechanisms in Chrome: WebRTC's `VCMTiming` stops scheduling render times at all (renders ASAP), and Blink swaps the `<video>` compositor pacing from `VideoRendererAlgorithm` to `LowLatencyVideoRendererAlgorithm`. `jitterBufferTarget`/`playoutDelayHint` from JS does **not** do this for video. Details in §1a.

---

### 1. Transport options for browser clients

### 1(a) WebRTC media track (`RTCPeerConnection` + `<video>`)

#### How Chrome's video jitter buffer actually computes delay

From `modules/video_coding/timing/timing.cc` / `.h` (webrtc main):

```cpp
static constexpr TimeDelta kDefaultRenderDelay = TimeDelta::Millis(10);   // timing.h:59
static constexpr int kDelayMaxChangeMsPerS = 100;                         // timing.h:60

TimeDelta VCMTiming::TargetDelayInternal() const {
  return std::max(min_playout_delay_,
                  jitter_delay_ + EstimatedMaxDecodeTime() + render_delay_);
}
```
- `render_delay_` defaults to **10 ms**.
- `EstimatedMaxDecodeTime()` = **95th percentile** of observed decode times (`decode_time_percentile_filter.cc`, `kPercentile = 0.95f`).
- `jitter_delay_` comes from `JitterEstimator::GetJitterEstimate()` (`modules/video_coding/timing/jitter_estimator.cc`):
  ```cpp
  constexpr TimeDelta kMinJitterEstimate = TimeDelta::Millis(1);   // line 67
  constexpr TimeDelta kMaxJitterEstimate = TimeDelta::Seconds(10); // line 68
  constexpr TimeDelta OPERATING_SYSTEM_JITTER = TimeDelta::Millis(10); // line 73
  ...
  TimeDelta jitter = CalculateEstimate() + OPERATING_SYSTEM_JITTER;  // line 438
  ```
  `CalculateEstimate()` is clamped to ≥ 1 ms, so on a *perfect* network `jitter_delay_` ≈ **11 ms** minimum. If `nack_count_ >= kNackLimit (3)` it additionally adds `rtt * rtt_multiplier` (line ~448).
- `UpdateCurrentDelay()` rate-limits movement of the delay: *"Never change the delay with more than 100 ms every second"* (`kDelayMaxChangeMsPerS = 100`). So even when conditions improve, the buffer drains at only 100 ms/s.

**⇒ Concrete floor on the normal path: ~11 ms (jitter) + p95 decode + 10 ms (render delay) ≈ 21 ms + decode.** With a typical 5–15 ms hardware decode that's **~26–36 ms** of receiver-side delay on an ideal LAN, before any network transit or compositor.

Corroboration from the field (secondary, but consistent): a discuss-webrtc thread (Thomas Fisher, Mar 2023 – Feb 2024) reports *"a consistent 80ms jitter buffer time for Chrome"* measured in `chrome://webrtc-internals`, against 1–2 ms for his native client — https://groups.google.com/g/discuss-webrtc/c/jkn_aW_aK9Q. An older thread has Christoffer Jansson (Nov 2015) stating *"It is currently not possible to control the jitter buffer size"* and Ben Weekes measuring Chrome's max jitter buffer at ~250 ms — https://groups.google.com/g/discuss-webrtc/c/qglHY5su4Rw.

#### The zero-playout-delay escape hatch (the important one)

```cpp
// timing.cc:35-37
constexpr TimeDelta kZeroPlayoutDelayDefaultMinPacing = TimeDelta::Millis(8);
constexpr TimeDelta kLowLatencyStreamMaxPlayoutDelayThreshold = TimeDelta::Millis(500);

// timing.cc:282
bool VCMTiming::UseLowLatencyRendering() const {
  // min_playout_delay_==0,
  // max_playout_delay_<=kLowLatencyStreamMaxPlayoutDelayThreshold indicates
  // that the low-latency path should be used, which means that frames should be
  // decoded and rendered as soon as possible.
  return min_playout_delay_.IsZero() &&
         max_playout_delay_ <= kLowLatencyStreamMaxPlayoutDelayThreshold;
}

// timing.cc:206 — RenderTimeInternal()
if (UseLowLatencyRendering()) {
  // Render as soon as possible or with low-latency renderer algorithm.
  return Timestamp::Zero();
}
```
And `MaxWaitingTime()` (timing.cc:234) then paces frames into the decoder at **minimum 8 ms apart** (`kZeroPlayoutDelayDefaultMinPacing`, overridable by field trial `WebRTC-ZeroPlayoutDelay` param `min_pacing`) *unless* `too_many_frames_queued`, in which case it returns zero wait.

**How that state is reached:** `min_playout_delay_`/`max_playout_delay_` are set from the frame's `EncodedImage().PlayoutDelay()` — i.e. **only from the `playout-delay` RTP header extension sent by the sender** (`video/video_receive_stream2.cc:756-760`, `UpdatePlayoutDelays()` at :1071-1137). `max_playout_delay_` defaults to **10 seconds** and nothing on the receiver JS side can lower it.

Spec of the extension — https://webrtc.github.io/webrtc-org/experiments/rtp-hdrext/playout-delay/ (also `docs/native-code/rtp-hdrext/playout-delay/README.md`):
- URI: `http://www.webrtc.org/experiments/rtp-hdrext/playout-delay`
- Wire: `| ID | len=2 | MIN delay (12 bits) | MAX delay (12 bits) |`, **10 ms granularity**, range **0–40950 ms**.
- Stated intent: *"Interactive streaming (gaming, remote access): Minimize delay; sender sets min=max=0"*.
- Status: experimental, never standardised at IETF.

**It is negotiated sendrecv by default in Chrome.** `media/engine/webrtc_video_engine.cc:872-880` lists `kPlayoutDelayUri` in the default `GetRtpHeaderExtensions()` set with `RtpTransceiverDirection::kSendRecv`, no field trial required.

#### Second effect: it switches Chrome's compositor pacing algorithm

`video/video_receive_stream2.cc:1125-1136`:
```cpp
if (frame_minimum_playout_delay_ == TimeDelta::Zero() &&
    frame_maximum_playout_delay_ > TimeDelta::Zero()) {
  constexpr Frequency kFrameRate = Frequency::Hertz(60);
  int max_composition_delay_in_frames = std::lrint(*frame_maximum_playout_delay_ * kFrameRate);
  max_composition_delay_in_frames = std::max(max_composition_delay_in_frames - buffer_->Size(), 0);
  timing_->SetMaxCompositionDelayInFrames(max_composition_delay_in_frames);
}
```
That lands in `VideoFrame::metadata().maximum_composition_delay_in_frames` (`media/base/video_frame_metadata.h:236`, *"This is an experimental feature, see crbug.com/1138888"*), and Blink then swaps algorithms — `third_party/blink/renderer/modules/mediastream/video_renderer_algorithm_wrapper.cc:30-43`:
```cpp
if (renderer_algorithm_ == RendererAlgorithm::kDefault &&
    frame->metadata().maximum_composition_delay_in_frames) {
  default_rendering_frame_buffer_.release();
  low_latency_rendering_frame_buffer_ = std::make_unique<LowLatencyVideoRendererAlgorithm>(media_log_);
  renderer_algorithm_ = RendererAlgorithm::kLowLatency;
}
```
`low_latency_video_renderer_algorithm.cc` (Blink, © 2020) constants:
- `kMaxPostDecodeQueueSize = 7` — above this, drop everything but the newest frame (*"we may run out of buffers in the HW decoder resulting in a fallback to SW decoder"*).
- `kReduceSteadyThreshold = 10` — after 10 consecutive renders where a newer frame was already queued, drop one extra to shrink the steady-state queue.
- `kDefaultMaxCompositionDelayInFrames = 6` when the metadata is absent on a frame.
- `kVsyncBoundaryErrorRate = 0.05` — *"Vsync boundaries are not aligned to 16.667ms boundaries on some platforms due to hardware and software clock mismatch."*
- Drain mode renders **2× frames per vsync** to burn down a backlog.
- UMA prefix `Media.RtcLowLatencyVideoRenderer.*`; the comment on `AverageQueueLengthX10` says the queue is *"expected to be in the range 1-3 frames"*.

#### `playoutDelayHint` / `jitterBufferTarget` — what they actually do

- **`playoutDelayHint`** (seconds, `RTCRtpReceiver`): Intent to Ship 4 Oct 2019 — https://groups.google.com/a/chromium.org/g/blink-dev/c/4W4orKqA3Rs. Originally trialled as `jitterBufferDelayHint`.
- **`jitterBufferTarget`** (milliseconds): Intent to Ship **12 Feb 2024**, targeted M123 — https://groups.google.com/a/chromium.org/g/blink-dev/c/bReU8otUmdk. Spec: https://w3c.github.io/webrtc-extensions/#dom-rtcrtpreceiver-jitterbuffertarget.
  - **Actually shipped Chrome 124** per chromestatus API (`Enabled by default`, desktop M124, android M124) and per MDN BCD (`api.RTCRtpReceiver.jitterBufferTarget` → chrome:124, firefox:115, safari:27). ⚠️ **Conflict flagged:** the Intent says 123, chromestatus and BCD say 124.
  - Range 0–4000 ms, `RangeError` outside — https://developer.mozilla.org/en-US/docs/Web/API/RTCRtpReceiver/jitterBufferTarget
  - MDN is explicit that it *"influences"* rather than sets the target, and the UA may change the actual target at any time.
- **Plumbing:** `RTCRtpReceiverImpl::SetJitterBufferMinimumDelay()` → `webrtc_receiver_->SetJitterBufferMinimumDelay()` → `VideoReceiveStream2::SetBaseMinimumPlayoutDelayMs()`, bounded by `kMinBaseMinimumDelay = 0` and `kMaxBaseMinimumDelay = 10 s` (`video_receive_stream2.cc:105-106,664`). That sets `base_minimum_playout_delay_`, one of three candidate *minimums* — it can only **raise** the floor, never lower it below `jitter + decode + render`.
- **Authoritative statement of the asymmetry** — Henrik Boström (henbos, Chrome WebRTC), 12 Apr 2023, https://lists.w3.org/Archives/Public/public-webrtc-logs/2023Apr/0095.html: on audio the hint *"is affecting the target jitter buffer"*; on video it *"is not affecting the jitter buffer directly, but rather the render timestamp being clamped within the min/max delay"*, and he proposes changing video to match audio.

**⇒ For Swoop: setting `receiver.jitterBufferTarget = 0` from JS is close to a no-op for video.** The sender-side header extension is the lever.

#### `abs-capture-time`
- Spec: https://github.com/webrtc/webrtc-org/blob/gh-pages/experiments/rtp-hdrext/abs-capture-time/index.md; IETF `draft-ietf-avtcore-abs-capture-time` (replaced `draft-alvestrand-avtcore-abs-capture-time`).
- URI `http://www.webrtc.org/experiments/rtp-hdrext/abs-capture-time`. Two forms: 8-byte (NTP 64-bit fixed-point capture timestamp) and 16-byte (+ 64-bit estimated capture clock offset, updated by each intermediate sender).
- *"A capture system SHOULD have known delays (e.g. from hardware buffers) subtracted from the readout."*
- **Default-off in Chrome:** `webrtc_video_engine.cc:886` registers `kAbsoluteCaptureTimeUri` with `RtpTransceiverDirection::kStopped`. To turn it on you need `RTCRtpTransceiver.setHeaderExtensionsToNegotiate()` — **Chrome/Edge 117+ only** (BCD: firefox:NO, safari:NO).
- When enabled, it surfaces in JS as `captureTime` in `requestVideoFrameCallback` metadata — that's your glass-to-glass measurement hook.

#### Also useful: `video-timing` header extension
`http://www.webrtc.org/experiments/rtp-hdrext/video-timing` (`kVideoTimingUri`, offered **sendrecv by default** in Chrome). 13 bytes: flags + six 16-bit ms deltas from capture time — *encode start, encode finish, packetization complete, last packet left the pacer,* + 2 reserved for in-network processors. Present only on the last packet of a frame. https://github.com/webrtc/webrtc-org/blob/gh-pages/experiments/rtp-hdrext/video-timing/index.md — this gives you per-stage host-side timing for free, readable in `getStats()`.

**Pros/cons summary (1a):** built-in congestion control, NACK/RTX, pacing, hardware decode, `<video>` compositor path, one-line multi-viewer via simulcast/SFU — but you inherit a jitter buffer you can only bypass via a non-standard sender-side extension, no control over pacing/CC internals, and (see §6) FEC is effectively off by default.

---

### 1(b) DataChannel + WebCodecs `VideoDecoder`

#### Spec facts (W3C WebCodecs, ED fetched 2026-09-17; TR is W3C Working Draft 14 September 2026)

⚠️ **Correction to the brief: `latencyMode` is on `VideoEncoderConfig`, not `VideoDecoderConfig`.** The decoder-side flag is `optimizeForLatency`.

```webidl
dictionary VideoDecoderConfig {
  ...
  HardwareAcceleration hardwareAcceleration = "no-preference";
  boolean optimizeForLatency = false;
  double rotation = 0;
  boolean flip = false;
};
```
> `optimizeForLatency`, of type boolean, defaulting to false — *"Hint that the selected decoder SHOULD be configured to minimize the number of EncodedVideoChunks that have to be decoded before a VideoFrame is output."*
> NOTE: *"In addition to User Agent and hardware limitations, some codec bitstreams require a minimum number of inputs before any output can be produced."*

```webidl
enum HardwareAcceleration { "no-preference", "prefer-hardware", "prefer-software" };
```
> *"`prefer-hardware` and `prefer-software` are hints. While User Agents SHOULD respect these values when possible, User Agents may ignore these values in some or all circumstances for any reason."*
> *"Setting a value of `prefer-hardware` or `prefer-software` can significantly restrict what configurations are supported."*

Note: per Bernard Aboba on the WebRTC list, *"`prefer-hardware` and `prefer-software` are interpreted as requirements in Chromium"*, even though the spec calls them hints.

`LatencyMode` (encoder only, §7.11): `"quality"` (default) vs `"realtime"` — in realtime, *"User Agents MAY sacrifice quality to improve latency"*, *"MAY drop frames to achieve the target bitrate and/or framerate"*, and `framerate` *"SHOULD be used as a target deadline for emitting encoded chunks"*.

Origin of `optimizeForLatency`: w3c/webcodecs#206, opened 29 Apr 2021, closed (PR #311) — *"some software decoders are optimized for throughput rather than latency via frame threading… without this hint some configurations would require a client to call flush() after every decode() call."*

#### Chromium implementation
`third_party/blink/renderer/modules/webcodecs/video_decoder.cc:352`:
```cpp
bool VideoDecoder::GetLowDelayPreference(const ConfigType& config) {
  return config.hasOptimizeForLatency() && config.optimizeForLatency();
}
```
…passed as the `low_delay` argument to `media::VideoDecoder::Initialize()`.

#### **The decoder frame-holding problem — concrete numbers**

This is the best primary thread on the subject: **w3c/webcodecs#732, "What's the best way to ensure 1-in 1-out decoding for h264 video?"** (opened 2023, comments Oct 2023) — https://github.com/w3c/webcodecs/issues/732

- Reporter (@snosenzo): H.264 **Baseline** profile gave 1-in-1-out; **Main** profile required *"filling up the decode queue with 4 frames after each keyframe before returning the first frame"*, then re-buffering after each subsequent keyframe. Config was `optimizeForLatency: true`, no B-frames, Annex-B. Setting `hardwareAcceleration: "prefer-software"` eliminated it.
- **Jean-Yves Avenard (31 Oct 2023):** *"the WMF (Windows) decoder has a default latency of about **25+ frames**, and if configured for low-latency will still be around **8 frames** on Windows 8 and 10. FFmpeg, if setup to use n-threads for decoding will have latency of n-frames. How the videos were encoded would have zero effects on the decode-specific behaviour above."*
- **Dan Sanders, Chrome media (31 Oct 2023) — the actionable part:**
  > *"There are two steps in decoding H.264; the first produces decoded frames in decode order, and then the decoded frames sit in a buffer to be output in presentation order. The default size of the buffer is large (**about 16 frames**), but it can be reduced in a few ways:*
  > - *It is possible to specify a `bitstream_restriction`, which can limit the size of the buffer (`max_dec_frame_buffering`) and signal the maximum time that a frame can wait around to be output (`max_num_reorder_frames`)…*
  > - *If frame reordering is used (usually true if there are B-frames), there is a minimum latency for reordering.*
  > - *Lower levels have smaller buffers. Different profiles set limits…*
  >
  > ***"Chrome's hardware decoders handle reordering themselves, and can in most cases reach the limit of `max_num_reorder_frames`. Disabling B-frame encoding therefore is usually enough to get 1-in-1-out behavior. Chrome's software decoder is FFmpeg, and the threading is configured based on the `optimizeForLatency` flag."***
- **Dale Curtis (25 Oct 2023):** *"you might be able to inject/rewrite the VUI field for `max_num_reorder_frames` to zero"*. **Eugene Zemtsov: "that's what webrtc does"** → `common_video/h264/sps_vui_rewriter.cc`.

I pulled that file. It force-writes the bitstream restriction:
```cpp
// sps_vui_rewriter.cc:398-409
// ********* IMPORTANT! **********
// The next two are the ones we need to set to low numbers:
// max_num_reorder_frames: ue(v)
// max_dec_frame_buffering: ue(v)
uint32_t max_num_reorder_frames = source.ReadExponentialGolomb();
uint32_t max_dec_frame_buffering = source.ReadExponentialGolomb();
RETURN_FALSE_ON_FAIL(destination.WriteExponentialGolomb(0));                       // reorder = 0
RETURN_FALSE_ON_FAIL(destination.WriteExponentialGolomb(sps.max_num_ref_frames));  // dec_frame_buffering = max_num_ref_frames
```
It sets `bitstream_restriction_flag = 1` and adds the block from scratch if absent (:316-319, :378-385).

**⇒ For Swoop the recipe is: encode with no B-frames, and write `vui_parameters_present_flag=1, bitstream_restriction_flag=1, max_num_reorder_frames=0, max_dec_frame_buffering=max_num_ref_frames` into the SPS.** Same reasoning applies to HEVC (`sps_max_num_reorder_pics`).

#### macOS / VideoToolbox
**w3c/webcodecs#899** (opened 23 Jul 2025, still open) — https://github.com/w3c/webcodecs/issues/899. ~**3-second** delay decoding H.264 (`avc1.64001F`, 1440×900, `optimizeForLatency: true`, `hardwareAcceleration: 'no-preference'`) from a macOS hardware encoder; the same bitstream decodes fine through native VideoToolbox APIs.
- Dale Curtis (23 Jul 2025): bitstream had `constraint_set3_flag=0` and no `max_num_reorder_frames=0` — pointed at #732.
- Reporter (2 Aug 2025) then set `max_num_ref_frames=1, vui_parameters_present_flag=1, bitstream_restriction_flag=1, max_num_reorder_frames=0, max_dec_frame_buffering=1` and reported **no improvement**: still 2–3 s delay on a static desktop, but only a few hundred ms when the screen was busy. Same on Chrome *and* Firefox. `prefer-software` worked in all cases.
- Dale Curtis (4 Aug 2025): *"Chrome's code definitely doesn't buffer a constant number of frames — we have cases of 1-in-1-out working when the bitstream is setup correctly."* Tracked as **crbug.com/436302044** (⚠️ I could not read issues.chromium.org — it requires sign-in — so the current status of that bug is **unverified**).
- **This is a live, unresolved risk for Swoop on macOS clients**: a low-framerate/static desktop is exactly the pathological case.

#### Windows / HEVC WebCodecs latency fix
Chromium commit **2023-07-26: "Fixed latency issue with VideoDecode implementation for H265"** (found via GitHub commit search on chromium/chromium). StaZhu's HEVC guide dates it 2023-07-28 and puts the fix in **Chrome ≥ 117.0.5913.0**.

#### Queue management guidance
- `decodeQueueSize` + `dequeue` event (`VideoDecoder.dequeue_event`: Chrome **106**, Firefox 130, Safari 16.4 — BCD). Chrome docs example pattern: *"If `encoder.encodeQueueSize > 2`, let's drop this frame"* — https://developer.chrome.com/docs/web-platform/best-practices/webcodecs (updated 2025-01-22). The doc gives **no** decoder queue-depth numbers.
- w3c/webcodecs#864 is an open issue that `decodeQueueSize`/`encodeQueueSize` behaviour is under-specified and web-compat-hazardous.

#### WebCodecs `VideoDecoder` support matrix (MDN BCD, fetched 2026-09-17)
| | Chrome | Firefox | Safari |
|---|---|---|---|
| `VideoDecoder` (all core methods) | **94** | **130** | **16.4** |
| `dequeue` event | 106 | 130 | 16.4 |
| `configure.rotation` / `.flip` | 138 | NO | NO |

Safari 16.4–18.7 shipped **only** the video interfaces (`VideoDecoder`, `VideoEncoder`, `EncodedVideoChunk`, `VideoFrame`) — no audio or image classes; full WebCodecs landed in **Safari 26.0** (macOS/iOS/iPadOS). *(Secondary source — I could not reach webkit.org or bugs.webkit.org from this environment; both ECONNRESET/timeout. Flagged as partially unverified.)*

**Pros/cons (1b):** total control of pacing, jitter handling, error recovery, and rendering; no jitter buffer at all; can render to WebGL/WebGPU with `desynchronized`. Costs: you write your own congestion control and loss recovery over an SCTP DataChannel (which is reliable-ordered by default — you want `{ordered: false, maxRetransmits: 0}`), you lose the `<video>` element's hardware overlay path, and you're exposed to the decoder-buffering issues above with no portable way to detect them ahead of time (padenot, 26 Oct 2023: *"the only way for authors to know is to try"*; suggests extending MediaCapabilities, not done).

---

### 1(c) WebSocket/HTTP + MSE — Chrome's "low delay" mode (what Parsec used)

Parsec's own writeup (late 2018, references Chrome 70 as upcoming): https://parsec.app/blog/game-streaming-tech-in-the-browser-with-parsec-5b70d0f359bc
- They use **`RTCDataChannel`s for transport** (*"UDP wrapped in an SCTP stream wrapped in DTLS"*, separate channels for video/audio/input) and **MSE only for decode+render**, packing frames into MP4 boxes and calling `appendBuffer`.
- *"Chrome begins to break the rules of MSE and no longer requires buffered playback"* — push model instead of buffered pull; *"it also starts to ignore certain timing information and keyframe requirements"*. Observable at `chrome://media-internals`.
- Chrome-only; *"Firefox works very differently from Chrome for handling video."*

**I traced the exact trigger in Chromium source.** It is *not* an API — it's inferred from the init segment:

`media/formats/mp4/mp4_stream_parser.cc:899-936`:
```cpp
} else {
  // In ISO/IEC 14496-12:2005(E), 8.30.2: ".. If an MP4 file is created in
  // real-time, such as used in live streaming, it is not likely that the
  // fragment_duration is known in advance and this (mehd) box may be omitted."
  // We have an unknown duration (neither any mvex fragment_duration nor moov
  // duration value indicated a known duration, above.)
  params.liveness = StreamLiveness::kLive;
}
```
i.e. **omit `mehd.fragment_duration` and leave `mvhd.duration` at 0 (or all-1s)** → liveness = live.

`media/renderers/video_renderer_impl.cc:200-207`:
```cpp
low_delay_ = stream->liveness() == StreamLiveness::kLive;
if (low_delay_) {
  MEDIA_LOG(DEBUG, media_log_) << "Video rendering in low delay mode.";
  // "Low delay mode" means only one frame must be buffered to transition to
  // BUFFERING_HAVE_ENOUGH.
  min_buffered_frames_ = 1;
}
```
Default without it (`video_renderer_impl.h:350`):
```cpp
Tuneable<size_t> initial_buffering_size_ = {
    "MediaInitialBufferingSizeForHaveEnough", 3, limits::kMaxVideoFrames, 10};
```
`limits::kMaxVideoFrames = 4` (`media/base/limits.h:27`). So **default = 4 frames buffered before playback (~67 ms at 60 fps); low-delay = 1 frame (~17 ms)**. Low-delay also disables the automatic underflow growth of `min_buffered_frames_` (:143, :472). `kAbsoluteMaxFrames = 24` is the hard cap either way.

**Latency floor for MSE:** ~1 frame of renderer buffering + the `<video>` compositor path (§3), plus whatever the decoder holds (§1b, same decoders). Realistically ~1 vsync better than default MSE, still ≥ 1–2 vsyncs of compositor.

**`HTMLMediaElement.latencyHint`** exists in Chromium but is **not shipped**: `html_media_element.idl:78-79` has `[RuntimeEnabled=MediaLatencyHint] attribute double latencyHint;`, and chromestatus feature 5160704082444288 ("HTMLMediaElement latencyHint", created 2019-10-26 by chcunningham, last touched 2022-10-29) is status **"Proposed"**, no milestone. Its summary literally names the use case: *"interactive video applications like cloud gaming and desktop streaming, where users must immediately see the effect of their inputs."* Usable behind `--enable-blink-features=MediaLatencyHint` only — not shippable.

**`ManagedMediaSource`** (BCD): Safari 17 / iOS 17.1 only; Chrome **NO**, Firefox **NO**. It's an iOS-Safari power/data-saving variant (`startstreaming`/`endstreaming`), not a latency feature — it exists mainly because plain `MediaSource` was unavailable on iPhone. Not useful for Swoop except as the *only* way to do MSE on iPhone.

**MSE in a worker**: Chrome 108+, Safari 18+, Firefox NO (`MediaSource.canConstructInDedicatedWorker`). Useful to keep append off the main thread.

---

### 1(d) WebTransport (HTTP/3 / QUIC)

- **Baseline since March 2026**, when Safari 26.4 shipped it — https://webrtc.ventures/2026/04/webtransport-is-now-baseline-what-it-means-for-real-time-media/ (Apr 2026) and https://developer.mozilla.org/en-US/docs/Web/API/WebTransport ("Baseline 2026, newly available since March 2026").
- BCD versions: **Chrome 97, Firefox 114, Safari 26.4** (Edge 98 per secondary sources; BCD mirrors Edge from Chrome). `datagrams`: Chrome 97 / FF 114 / Safari 26.4.
- **It cannot do P2P.** It is strictly client↔server. Confirmed by the webrtc.ventures piece and by the spec's HTTP/3 basis. For Swoop this means WebTransport is only viable via a relay, which costs you the whole P2P latency advantage (and adds egress cost for multiple viewers, although a relay is how you'd fan out to many viewers anyway).
- **Congestion control: you get almost nothing in Chrome.** BCD:
  - `WebTransport.congestionControl` → **chrome: NO**, firefox: 114, safari: 26.4
  - `options.congestionControl` constructor param → **chrome: NO**, firefox: 114, safari: 26.4
  - `options.requireUnreliable` → **chrome: NO**
  - `options.allowPooling` → **chrome: NO**
  - `createBidirectionalStream({sendOrder})` / `createUnidirectionalStream({sendOrder})` → **chrome: NO**, firefox 119
  - `createSendGroup` → chrome NO, firefox 155, safari 26.4
  - `getStats()` → **chrome: NO**, firefox 114 (partial), safari 26.4
  - `exportKeyingMaterial` → chrome NO, firefox 155, safari NO
  - `serverCertificateHashes` → chrome 100, firefox 125, safari 26.4 (lets you use a self-signed cert with a ≤14-day validity — relevant if you want a Swoop relay without a public CA cert)
  - `options.protocols` → chrome 143, firefox 155, safari 26.4
  
  So on Chrome you cannot ask for low-latency CC, cannot read connection stats, and cannot prioritise streams. chromestatus lists "WebTransport reliability attributes", "Datagram writable streams and prioritization", "Datagram readable stream type", "keying material export" all as **"Proposed"**, no milestone.
- Reachability: UDP/443 is filtered on some networks; the webrtc.ventures piece notes WebTransport's reachability ceiling is **below WebSocket's**, and there's an HTTP/2-over-TCP fallback in the spec (which would obviously defeat the purpose).
- DevTools: Chrome shows the connection but **not datagram payloads**; Firefox/Safari only surface the handshake. Debugging is worse than WebRTC's `webrtc-internals`.

**Verdict for Swoop:** not a replacement for the P2P path. Plausible as the *relay/TURN-equivalent* fallback path if you want your own congestion control, and as the multi-viewer fan-out path.

---

### 1(e) Encoded Transform / `RTCRtpScriptTransform`

- Spec: https://w3c.github.io/webrtc-encoded-transform/
- **Chrome shipped the standard API in M141** — Intent to Ship 13 Aug 2025, https://groups.google.com/a/chromium.org/g/blink-dev/c/QeosFeu-d8A. *"Chromium shipped an early version of this API in 2020. Since then, the spec has changed and other browsers have shipped the updated version."* Part of Interop 2025. **`generateKeyFrame` is excluded** (still under W3C discussion). Old `createEncodedStreams()` keeps working.
- BCD: `RTCRtpScriptTransform` / `RTCRtpSender.transform` → **Chrome 141, Firefox 117, Safari 15.4**.
- `RTCEncodedVideoFrame` → Chrome 86, Firefox 117, Safari 15.4. The **constructor** (needed to synthesise frames) → Chrome 127, Firefox 145, Safari 26.
- Runs a `TransformStream` **in a Worker**, so it's off the main thread.

**Uses for Swoop:** stamp your own capture/send timestamps into frame metadata for exact glass-to-glass measurement; implement E2EE; drop stale frames on the receive side before they reach the decoder; inspect frame sizes for your own pacing telemetry. It does **not** let you bypass the jitter buffer — the receive-side transform sits after depacketization but the frame still goes through `VCMTiming`.

Related, both **"Proposed"/unshipped** on chromestatus as of today:
- **"WebRTC Encoded Source"** (created 2026-09-04): insert already-encoded media directly into an `RTCPeerConnection` — i.e. use a WebCodecs/WASM encoder as the PC's source. Would be a big deal for a browser→browser Swoop, irrelevant for native-host→browser.
- **"Manual reference frame control in VideoEncoder"** (created 2025-09-17): WebCodecs API to control which previous frames a frame references — the LTR/RPS primitive. Encoder-side only, and not shipped.
- **"Expose rtpTimestamp from WebRTC video frames via VideoFrame.metadata()"** — status Proposed, M145 listed. Spec: https://www.w3.org/TR/webcodecs-video-frame-metadata-registry/

---

### 2. HEVC / H.265 in browsers as of 2026

### WebRTC (`RTCPeerConnection`)
- **Chrome 136, all six Blink platforms (Win/Mac/Linux/CrOS/Android/WebView), send + receive, enabled by default.** Intent to Ship **3 March 2025**: https://groups.google.com/a/chromium.org/g/blink-dev/c/3h8lL8a377c. Confirmed by chromestatus API (`H265 (HEVC) codec support in WebRTC` → Enabled by default, desktop M136, android M136).
  - **Hardware-only, no software fallback.**
  - New MIME `video/H265`, exposed via MediaCapabilities, SDP, and `RTCRtpTransceiver.setCodecPreferences()`.
  - Finch flags: `WebRtcAllowH265Send`, `WebRtcAllowH265Receive`.
  - Hardware coverage cited in the Intent: **75% Windows, 99% macOS, 86% Android, 90% iOS**.
  - StaZhu's guide pins it precisely at **136.0.7077.0** (default-on landed 2025-03-19), decode cross-platform, encode on Windows/macOS/Android.
- **Edge does NOT publish H.265 in WebRTC** even on HEVC-capable hardware, as of May 2026 — MSEdgeExplainers issue #1314 / Microsoft Q&A. ⚠️ Notable: Edge is Chromium but diverges here.
- **Firefox: no.** (vdo.ninja H.265 checker; Firefox standards position was "under discussion" per the Chrome Intent.)
- **Safari: yes, shipped before Chrome** — stated in the Chrome Intent to Ship (3 Mar 2025): *"Safari already shipped HEVC in WebRTC."* ⚠️ **I could not verify the exact Safari version** — webkit.org and bugs.webkit.org were unreachable from this environment.
- **IETF: `draft-ietf-avtcore-hevc-webrtc-09`, latest revision 20 July 2026, currently in WG Last Call**, milestone August 2026 — https://datatracker.ietf.org/doc/draft-ietf-avtcore-hevc-webrtc/. Authors Bernard Aboba (Microsoft, d. Feb 2025), Philipp Hancke (Microsoft), Jianlin Qiu (Intel). Key normative bits:
  - MUST support **Main Profile Level 3.1 (`level-id=93`)**, SHOULD support Main Profile Level 4 (`level-id=120`).
  - `level-id` defaults to 93 if absent; `tx-mode` defaults to `"SRST"`.
  - Implementations **MUST NOT** put sequence/picture parameter sets in SDP — VPS/SPS/PPS must be **in-band**.
  - MUST NOT aggregate VCL NAL units with lower-TID non-VCL units in one packet; prefix SEI in IRAP pictures must not precede VPS/SPS/PPS.

### WebCodecs
- **Chrome: 8-bit HEVC decode from 107.0.5272.0; 10-bit + alpha from 108.0.5343.0** (StaZhu, https://github.com/StaZhu/enable-chromium-hevc-hardware-decoding). HEVC hardware decoding enabled by default from **Chrome 107** (chromestatus: "Enable HEVC hardware decoding", Enabled by default, M107). **HEVC hardware *encoding* (`VideoEncoder`) from Chrome 130.0.6703.0**; before that `--enable-features=PlatformHEVCEncoderSupport`.
- **Chrome has no software HEVC decoder at all.** `media/media_options.gni:150-156`:
  ```
  # Enable HEVC/H265 demuxing. Actual decoding must be provided by the platform.
  enable_platform_hevc = proprietary_codecs && (enable_hevc_parser_and_hw_decoder || is_cast_media_device)
  ```
  ⇒ **`prefer-software` is not an escape hatch for HEVC** the way it is for H.264. If the client GPU can't decode HEVC, you get nothing. **Swoop must carry an H.264 (and ideally AV1) fallback.**
- Platform decoders: Windows `D3D11VideoDecoder` (D3D11VA); macOS `VideoToolboxVideoDecoder`; Linux/CrOS `VaapiVideoDecoder` (Chrome 108.0.5354.0+, VAAPI only, Main/Main10 only).
- OS minimums: Windows 8+, macOS Big Sur 11.0+, Android 5.0+.
- GPU minimums (StaZhu): Intel HD4400/HD515+ iGPU or DG1+; NVIDIA GT635+ (Turing+ for 12-bit RExt); AMD RX460/R7/Vega M+; Apple M1+; Qualcomm Adreno 618+.
- Windows encode caps: pre-131 hardcoded **1920×1088 @ 30 fps**; Chrome 131+ up to **7680×4320 @ 300 fps**; macOS Apple Silicon 131+ **8192×4352 @ 120 fps**, Intel Mac **4096×2304 @ 120 fps**.
- **Codec strings** — W3C "HEVC (H.265) WebCodecs Registration", **Group Note Draft 8 June 2026**, https://www.w3.org/TR/webcodecs-hevc-codec-registration/: prefix `hev1.` or `hvc1.` + four dot-separated fields (ISO/IEC 14496-15 §E.3). Two chunk formats: `"hevc"` (hvcC-style, parameter sets in `description`, **excluded** from the bitstream) and `"annexb"` (parameter sets **repeated in-band**, *"enabling mid-stream access in live-streaming scenarios"* — this is what Swoop wants). Per-frame `quantizer` 0–51 via `VideoEncoderEncodeOptionsForHevc`.
- Practical profile strings: Main `hev1.1.6.L93.B0`, Main10 `hev1.2.4.L93.B0`, Main still `hvc1.3.E.L93.B0`, RExt `hvc1.4.10.L93.B0`.
- **Always gate on `VideoDecoder.isConfigSupported()`** — and note there was a Chromium bug where it *threw* rather than resolving `{supported:false}` for unsupported configs, so wrap it in try/catch.
- **Safari WebCodecs HEVC**: partial WebCodecs 16.4–18.7 (video interfaces only), full in 26.0; HEVC decode via VideoToolbox is available. ⚠️ Exact Safari-version behaviour for `hvc1.*` in `isConfigSupported` is **unverified** (webkit.org unreachable).
- **Firefox**: no HEVC. Devs are using WASM transcoders (e.g. `lid-labs/hevc.js` transcodes HEVC→H.264 client-side) as a workaround — not viable at Swoop's latency target.

### AV1
- **Chrome AV1 decoder since M70; AV1 encoder since M90** (chromestatus). AV1 is in WebRTC and WebCodecs.
- Hardware decode availability (https://en.wikipedia.org/wiki/AV1, hardware section):
  - **Intel**: Xe and later decode; Xe2+ decode **and** encode.
  - **NVIDIA**: RTX 30 decode only; RTX 40+ decode + encode.
  - **AMD**: RDNA 2 decode (excluding Navi 24); RDNA 3+ decode + encode.
  - **Apple**: M3+ and A17 Pro / A18 decode only, **no AV1 encode**.
  - **Qualcomm**: Snapdragon 8 Gen 2+ decode; Snapdragon X Plus/Elite and X2 decode + encode.
  - **MediaTek**: Dimensity 1000/8000/9000, MT96XX, MT9950, Pentonic — decode only.
- **⇒ AV1 hardware decode coverage in 2026 is materially worse than HEVC's** (no pre-2021 GPUs, no Intel pre-Xe, no Apple pre-M3). Software AV1 decode (dav1d) exists in Chrome as a fallback, unlike HEVC — but dav1d at 1440p60 will eat a lot of CPU and add frame-threading latency unless `optimizeForLatency` forces single-thread.

**Recommendation for Swoop's codec ladder:** H.264 (High profile, no B-frames, VUI reorder=0) as the universal floor → HEVC where `isConfigSupported` + hardware says yes (best bitrate/quality at the same latency) → AV1 only where hardware decode is confirmed.

---

### 3. Rendering / display path in the browser

### `requestVideoFrameCallback` (rVFC)
- Spec: **WICG Draft Community Group Report, 2 August 2024** — https://wicg.github.io/video-rvfc/
- `VideoFrameCallbackMetadata`:
  - **required**: `presentationTime` (*"time at which the user agent submitted the frame for composition"*), `expectedDisplayTime` (*"time at which the user agent expects the frame to be visible"*), `width`, `height` (media pixels), `mediaTime` (seconds; *"MAY have a zero value for live-streams or WebRTC applications"*), `presentedFrames` (*"MUST be monotonically increasing"*).
  - **optional**: `processingDuration` (seconds, *"from submission of the encoded packet … to the decoder until the decoded frame was ready for presentation"*), `captureTime`, `receiveTime` (*"the time the encoded frame was received by the platform"*, remote sources), `rtpTimestamp`.
  - `captureTime`/`receiveTime`/`rtpTimestamp` are **WebRTC-only** and depend on `abs-capture-time` being negotiated (§1a).
- Callbacks run **immediately before `requestAnimationFrame` callbacks** in the rendering steps. The spec is explicit there are *"no strict timing guarantees"* and the callback **may fire one v-sync late**.
- web.dev (8 Jan 2023, https://web.dev/articles/requestvideoframecallback-rvfc):
  - Fire rate = **min(video rate, browser rate)**. 25 fps video on 60 Hz → 25 Hz callbacks (unlike rAF's ~60).
  - If `expectedDisplayTime` is within **~5–10 µs** of `now`, the frame is **already rendered** (you're a vsync late). If it's ~**16 ms** in the future (60 Hz), you're in sync.
  - Worst case: *"the frame is ready at vsync x, the callback is fired and the frame is rendered at vsync x+1, and changes made in the callback are rendered at vsync x+2."*
- **Support (MDN BCD, fetched today): Chrome 83, Firefox 132, Safari 15.4.** Baseline Oct 2024.
  ⚠️ **Conflict flagged:** a WebFetch summary of the MDN page claimed Chrome 123 / Firefox 126 / Safari 17.4. The raw BCD JSON and the web.dev article both say **83 / 132 / 15.4**; I'm confident BCD is right and the summary hallucinated from the Baseline badge.

### Compositor-added latency — concrete numbers from Chromium
`third_party/blink/renderer/platform/graphics/video_frame_submitter.cc` (`OnBeginFrame`):
```cpp
base::TimeTicks deadline_min = args.frame_time + args.interval;
base::TimeTicks deadline_max = args.frame_time + 2 * args.interval;
// Default expected display time for tracing: the end of the BeginFrame
// deadline window (two intervals after frame_time).
```
**⇒ Chrome's own model is that a frame submitted during a BeginFrame is displayed 1–2 vsync intervals later: 16.7–33.3 ms at 60 Hz, 8.3–16.7 ms at 120 Hz.**

Newer code computes the real number empirically: it takes `presentation_feedback.timestamp - received_compositor_frame_timestamp` per frame and keeps an **exponential moving average with smoothing factor 0.2**, then reports `frame_expected_display_time = Now() + EMA` to the `FrameExpectedDisplayTime` trace event. Feedback is trusted only when `gfx::PresentationFeedback::kHWCompletion` or `kVSync` is set (and on Linux the failure flag is unreliable — *"perfectly rendered frames are reported as failures all the time"*).

### `desynchronized` canvas
- https://developer.chrome.com/blog/desynchronized (**2 May 2019**); chromestatus: "Low latency canvas contexts with desynchronized" → **Enabled by default, Chrome 75** (desktop and Android). Previously named `lowLatency` (≤ Chrome 74).
- *"tells the underlying system to skip as much compositing as it is able and in some cases, the canvas's underlying buffer is sent directly to the screen's display controller"* — eliminates the renderer compositor queue.
- Contexts: `'2d'`, `'webgl'`, `'webgl2'`. **WebGPU is not mentioned.**
- Constraints: the canvas **must not have any DOM elements above it** if alpha is used; set `preserveDrawingBuffer: true` for WebGL to avoid flicker; can't change context attributes after the first `getContext()`.
- Caveat: *"Devices with front buffer rendering such as ChromeOS for example may have tearing."*
- **No measured latency reduction is published.** The article only motivates it with *"latencies longer than 50 milliseconds can interfere with a user's hand-eye coordination."* ⚠️ I could not find a published measurement of how many ms `desynchronized` saves.

### `<video>` vs canvas/WebGL for WebCodecs output
- `<video>` gets you the `VideoFrameSubmitter` path, hardware overlay/zero-copy where available, and rVFC metadata — but you can only feed it via MSE or a MediaStreamTrack, and you inherit the renderer's frame buffering (§1c).
- `VideoFrame` → `canvas.drawImage()` / `texImage2D` / WebGPU `importExternalTexture` gives you exact control of *when* a frame is painted, and combined with `desynchronized: true` bypasses compositor double-buffering. Cost: you lose overlay/zero-copy on some platforms (a GPU→GPU copy), and you must drive your own rAF loop.
- Note: `VideoFrame.close()` discipline matters; Chrome's guidance is to keep a *steady state* of frames in flight — *"dumping frames in as a huge batch causes huge amounts of memory pressure and competition for GPU task scheduling."*

**⇒ Realistic browser-side display budget:** ~1–2 vsyncs of compositor (16.7–33.3 ms @ 60 Hz; 8.3–16.7 ms @ 120 Hz) with `<video>`, potentially ~1 vsync less with WebGL + `desynchronized`, plus display panel latency (not observable from JS).

---

### 4. Input path

### Pointer
- **`pointerrawupdate`** — https://developer.mozilla.org/en-US/docs/Web/API/Element/pointerrawupdate_event; W3C Pointer Events (CR Snapshot, Call for Wide Review, Apr 2025).
  - **BCD: Chrome 77, Firefox 148, Safari NO.** Secure context required.
  - *"A browser may delay `pointermove` events to improve performance, while `pointerrawupdate` events are dispatched as soon and as frequently as the browser can produce them."* Both coalesce; `pointerrawupdate` coalesces **less**.
  - **Important caveat from MDN:** both carry the same property values per event — `pointerrawupdate` is *"not more precise in space or time, just more frequent."* The precision comes from `getCoalescedEvents()`, not from the event type.
  - MDN performance warning: *"An application that cannot keep up will feel less responsive rather than more."*
- **`getCoalescedEvents()`**: BCD Chrome 58, Firefox 59, **Safari 18.2**. This is how you recover the full high-rate mouse trace (1000 Hz mice) even though events are delivered at rAF cadence. Each coalesced event carries its own `timeStamp` — send those deltas to the host so it can replay the motion with correct sub-frame ordering.
- **`getPredictedEvents()`**: BCD Chrome 77, Firefox 89, **Safari 18.2**. Browser-side prediction; useful for local cursor rendering to hide RTT, **not** for what you send to the host (you'd be sending fabricated input).
- **Pointer Lock `unadjustedMovement`** — Pointer Lock 2.0, https://w3c.github.io/pointerlock/; web.dev "Disable mouse acceleration to provide a better FPS gaming experience".
  - **BCD: `Element.requestPointerLock` → Chrome 37, Firefox 50, Safari 10.1, Safari iOS NO. `options.unadjustedMovement` → Chrome 88, Firefox 152, Safari 18.4, Safari iOS NO, Chrome Android 144.**
  - ⚠️ Multiple secondary sources still say "Chromium only" — that's stale; per BCD, Firefox 152 and Safari 18.4 now support it.
  - Removes OS mouse acceleration/ballistics → raw deltas. **Essential** for Swoop's relative-mouse mode; without it, host-side motion won't match what the user's hand did.
  - Platform support for the *unadjusted* part: ChromeOS, macOS Catalina 10.15.1+, Windows.
  - Parsec's note still holds: Pointer Lock activation is restricted outside fullscreen (user-gesture + re-lock cooldown after an Escape).
- **Absolute vs relative:** use `movementX/movementY` (locked, unadjusted) for relative; use `clientX/clientY` scaled to the remote desktop for absolute. You need both — absolute for normal desktop use, relative for games/3D apps — and a host→client signal when the remote app captures the cursor, exactly as Parsec describes.

### Keyboard
- `KeyboardEvent.code` is the physical-key identifier (layout-independent) — that's what you send; `key` is layout-dependent and useless for remoting modifier/gaming keys. (Standard; no new findings.)
- Note for Swoop: `code` gives you a spec string like `"KeyA"`, which you map to a Windows scancode on the host. Do **not** map via `keyCode`.

### Gamepad
- **Chromium polls gamepads internally at 4 ms (~250 Hz):** `device/gamepad/gamepad_provider.cc:78` — `constexpr int64_t kPollingIntervalMilliseconds = 4;  // ~250 Hz`, used as `sampling_interval_delta_`.
- But `navigator.getGamepads()` is a **snapshot-on-read** API with no event for axis movement, so the *effective* rate is however often your JS reads it. If you poll from rAF you get 60 Hz (16.7 ms) — that alone can add up to ~16 ms of input latency. **Poll from a `setInterval`/worker at ~4–8 ms rather than rAF.** `Gamepad.timestamp` lets you detect duplicate snapshots.
- BCD: Gamepad → Chrome 21, Firefox 29, Safari 10.1. `vibrationActuator` → Chrome 68, Safari 16.4, Firefox NO, Safari iOS NO.

### Host side: Windows `SendInput`
https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-sendinput (page content last updated 2025-07-01; `ms.date` 2018-12-05)
- *"This function is subject to UIPI. Applications are permitted to inject input only into applications that are at an equal or lesser integrity level."* **This is the landmine for Swoop:** a non-elevated host service cannot drive an elevated window (UAC prompt, Task Manager, any admin app). And: *"neither GetLastError nor the return value will indicate the failure was caused by UIPI blocking"* — it just silently returns 0. (Note the Owlette CLAUDE.md constraint about never raising UAC unattended — the same tension applies here; running the input injector at a higher integrity level is a deliberate design decision, not a default.)
- *"If the function returns zero, the input was already blocked by another thread."*
- *"inserts the events … **serially** into the keyboard or mouse input stream. These events are not interspersed with other keyboard or mouse input events inserted either by the user … or by calls to `keybd_event`, `mouse_event`, or other calls to `SendInput`."* — i.e. one `SendInput` call's batch is atomic; **batch a frame's worth of coalesced moves into one call** rather than N calls.
- *"This function does not reset the keyboard's current state"* — you must reconcile with `GetAsyncKeyState` (stuck-modifier bugs on reconnect).
- **No latency figure is documented.** ⚠️ I could not find a primary source quantifying `SendInput` cost. It is a user32 call that posts into the raw input thread's queue; it is not synchronous to the target app's message loop. Treat as sub-millisecond but **unverified**.
- `MOUSEEVENTF_ABSOLUTE` coordinates are normalised **0–65535** across the primary monitor, or across the whole virtual desktop with `MOUSEEVENTF_VIRTUALDESK`. ⚠️ The 0–65535 normalisation is in the `MOUSEINPUT` doc, not the `SendInput` page I fetched — verify against `ns-winuser-mouseinput` before implementing.
- `SetCursorPos` is the cruder alternative: it moves the cursor but does **not** generate a mouse-move in the raw input stream, so games using DirectInput/Raw Input won't see it. **Use `SendInput` with `MOUSEEVENTF_MOVE` (relative) for captured-cursor apps; `SendInput` with `MOUSEEVENTF_ABSOLUTE|MOUSEEVENTF_MOVE` for normal desktop.**

### Input-path latency budget
Browser event dispatch (rAF-coalesced: up to 16.7 ms; `pointerrawupdate`: ~device rate) → DataChannel/DTLS/SCTP serialisation (~0, sub-ms) → network one-way (RTT/2) → host deserialise + `SendInput` (sub-ms) → app reads on its next input poll / message pump (0–16.7 ms at 60 Hz). **The two rAF-cadence quantisations at each end are the biggest avoidable chunks.**

---

### 5. Latency measurement work

### Published pipeline breakdowns
**Transitive Robotics, "WebRTC Latency: A Breakdown", 6 May 2026** — https://transitiverobotics.com/blog/webrtc-latency-breakdown/. Infinite-mirror method (camera pointed at a screen showing its own feed with overlaid timestamps). Hardware: RealSense D435 / Logitech C925e / 2MP wide-angle over USB3, Ubuntu 24.04, 30 fps, 60 Hz display, **software** H.264.

| Stage | Latency |
|---|---|
| Camera capture + USB | ~100 ms |
| H.264 encode | ~10 ms |
| Network (static) | ~30 ms |
| Jitter buffer | ~10 ms |
| H.264 decode | ~10 ms |
| Display refresh | ~17 ms |
| **Total** | **~170 ms** |

Their conclusion: *"WebRTC only adds around 10 ms of latency"* — the rest is camera + USB. **For Swoop the capture stage is a desktop duplication (DXGI), not a USB camera, so the ~100 ms camera term collapses to roughly one frame interval.** That is the whole reason a 50–100 ms target is achievable for screen streaming and not for webcam streaming.

⚠️ Note their "jitter buffer ~10 ms" contradicts my source analysis (§1a floor ≈ 21 ms + decode) and the 80 ms field report. Possible explanations: they may be reading `jitterBufferDelay/jitterBufferEmittedCount` which excludes the render-delay and decode-time terms, or the numbers are approximate. **Flagging as a conflict; trust the source-code arithmetic and measure it yourself with `getStats()`.**

Generic figures from a low-latency streaming survey (secondary, forasoft/getstream, 2026): real-time protocols use *"aggressive buffers of just 10–50 ms"*; decode *"5–15 ms per frame"*; display refresh *"8–16 ms at 60Hz"*; WebRTC glass-to-glass typically *"200 to 500 ms"* for camera-sourced video.

A 2015 methodology paper (arXiv 1510.01134) reports **G2G precision of 0.5 ms at a 2 kHz sampling rate** — useful if you want to build a rig.

### Cloud gaming measured input latency
⚠️ **All of these are second-hand from search-result summaries; I did not reach the original Digital Foundry videos or Ars Technica articles. Treat as indicative, not citable.**
- Digital Foundry, GDC March 2019: wired Stadia demo **166 ms** total, vs **~100 ms** on a local 60 fps PC.
- Ars Technica (2019): xCloud **67 ms** input lag vs Stadia **166 ms**.
- January 2022: Stadia **87 ms over browser, wired**.
- Digital Foundry (John Linneman), early 2026: *"the gap between local and cloud play has narrowed to the point where most people won't notice it in single-player games on a good connection – but competitive multiplayer is still local-first territory."*

### Stadia network behaviour (primary, peer-reviewed)
**"Cloud-gaming: Analysis of Google Stadia traffic"**, Marc Carrascosa & Boris Bellalta (UPF), arXiv:2009.09786, 2020. Wireshark capture on wired Ethernet, three games, March–July 2020, throttled with Wondershaper.
- **RTT 10–15 ms average, consistently < 25 ms** under normal conditions; peaks to 35+ ms under bandwidth constraint. **95th percentile RTT below one frame duration (16.67 ms).**
- Downlink: **~10 Mbps at 720p; 23–28 Mbps at 1080p; up to 43.74 Mbps at 4K.** Uplink ~**37× lower**.
- 60 fps sustained; drops to 5–10 fps transiently under stress, with recovery up to **287 s** for severe bandwidth drops (bad rate-control hysteresis).
- Video packets **~1194 bytes** average; audio **~360 bytes at 20 ms** periodicity; STUN/DTLS 81–135 bytes.
- Transport: WebRTC (RTP/RTCP/DTLS/STUN).

**⇒ Swoop's 50–100 ms input-to-photon is achievable only if:** capture ≤ 1 frame, encode ≤ 1 frame, network one-way ≤ ~10 ms, receiver buffering ≈ 0 (requires the playout-delay extension or WebCodecs), decode 1-in-1-out (requires the SPS VUI fix), compositor 1–2 vsyncs. At 60 Hz the vsync quantisation alone (capture vsync + display vsync) is ~33 ms of the budget. **120 Hz+ on both ends is worth more than almost any protocol optimisation.**

---

### 6. Pitfalls and mitigations

### Jitter-buffer floor
Covered in §1a. Mitigations in priority order:
1. **Sender emits `playout-delay` with min=0, max ∈ (0, 500] ms.** Negotiated sendrecv by default in Chrome. Unlocks render-ASAP + the low-latency renderer algorithm.
2. Don't bother with `jitterBufferTarget` for video (henbos, 2023).
3. If you must go lower than what WebRTC allows, move to DataChannel + WebCodecs and own the buffer.
4. Watch `RTCInboundRtpStreamStats`: `jitterBufferDelay / jitterBufferEmittedCount` for the average, and compare against `jitterBufferMinimumDelay` (*"the minimum jitter buffer delay that might be achieved given only the network characteristics"*) to see how much of your delay is network vs. policy. Also `jitterBufferTargetDelay`, `totalProcessingDelay`.

### Frame pacing
- Chrome's `LowLatencyVideoRendererAlgorithm` already implements the "don't let the queue build" idea: **drain mode renders 2× frames/vsync**, `kMaxPostDecodeQueueSize = 7` hard-drops, `kReduceSteadyThreshold = 10` shaves the steady-state queue. You get this for free by setting the playout-delay extension.
- The 8 ms `kZeroPlayoutDelayDefaultMinPacing` is fine at 60 fps but becomes a constraint above ~125 fps; overridable via the `WebRTC-ZeroPlayoutDelay/min_pacing` field trial, which you cannot set in a normal browser.
- **"Don't send frames the client can't display":** SQP (below) implements exactly this as frame-coupled paced packet trains. On the Swoop host, the cheap version is to gate capture on the estimated client display cadence and skip encode entirely when the desktop hasn't changed (which is also what makes the macOS WebCodecs bug in §1b bite — a static desktop starves the decoder).

### Keyframe-free recovery
- **WebRTC has no RPSI.** I searched the whole webrtc mirror: `rpsi` appears **once**, as a comment example in `media/base/codec.h:47` (`std::string param_; // e.g. "", "rpsi", "fir"`). It is not implemented.
- Chrome's default video RTCP feedback set (`webrtc_video_engine.cc:132-149`, `AddDefaultFeedbackParams`): **`goog-remb`, `transport-cc`, `ccm fir`, `nack`, `nack pli`**. Plus `lntf` (RTCP **Loss Notification**, `modules/rtp_rtcp/source/rtcp_packet/loss_notification.h`, © 2019) — but **only for VP8 and only when the field trial `WebRTC-RtcpLossNotification` is enabled**, so effectively unavailable in stock Chrome.
- `LossNotification` carries `(last_decoded, last_received, decodability_flag)` — that's the primitive for reference-frame invalidation, but it's gated and VP8-only.
- **⇒ On the WebRTC media-track path, your only loss recovery signals from Chrome are NACK (RTX) and PLI (full keyframe).** No LTR/RPSI. If you want intra-refresh or long-term-reference recovery, you must either (a) implement it purely sender-side and blind (periodic intra refresh columns, ignoring feedback), or (b) go WebCodecs + DataChannel and build your own feedback channel.
- WebCodecs' "Manual reference frame control in VideoEncoder" (chromestatus, Proposed, no milestone, created 2025-09-17) would give browsers this — irrelevant to Swoop's native host, which can do LTR directly via NVENC/AMF/QSV/Media Foundation.
- **Intra refresh** is not exposed anywhere in the web platform; it's purely a host-encoder setting. NVENC/AMF/MF all support it. It removes keyframe bitrate spikes, which is what actually causes the queue-build → latency spike loop in cloud gaming.

### FEC vs NACK
From `modules/video_coding/media_opt_util.h:46` and `.cc:105-122`:
```cpp
constexpr int64_t kLowRttNackMs = 20;
// Hybrid Nack FEC has three operational modes:
// 1. Low RTT (below kLowRttNackMs) - Nack only: Set FEC rate to zero.
// 2. High RTT (above _highRttNackMs) - FEC Only.
// 3. Medium RTT values - Hybrid mode: We will only nack the residual
//    following the decoding of the FEC.
```
**⇒ WebRTC turns FEC off entirely below 20 ms RTT and relies on NACK/RTX.** For a LAN or same-metro Swoop session that's the right call (a NACK round trip at 5 ms RTT costs less than FEC overhead). Above ~20–30 ms RTT, a NACK retransmit costs ≥ 1 full RTT of added latency, and FEC wins.

**FlexFEC status in Chrome** (`webrtc_video_engine.cc`):
- `flexfec-03` is *always* offered as a **receive** codec (`is_decoder_factory` branch, line 178); it is only offered as a **send** codec if the field trial `WebRTC-FlexFEC-03-Advertised` is enabled.
- Sending FlexFEC is additionally gated: line 1107 — *"Never enable sending FlexFEC, unless we are in the experiment"* (`WebRTC-FlexFEC-03`), which zeroes `flexfec_payload_type`. Line 1904 gates the FlexFEC SSRC wiring on the same trial. Only **one** FlexFEC stream is supported.
- `repair-window` fmtp is hardcoded to `"10000000"` (µs = 10 s) with the comment *"we never use the actual value anywhere in our code however."*
- **⇒ A native Swoop host CAN send flexfec-03 to a stock Chrome receiver** (Chrome accepts it as a receive codec), even though Chrome itself won't send it. That's a real, underused lever for the TURN-relayed / high-RTT case.
- `red` + `ulpfec` are also offered (lines 174-175); ULPFEC is in-band and costs a payload-type indirection but works with older stacks.
- Reed-Solomon / RaptorQ are not available on the WebRTC path at all — those would require the WebCodecs+DataChannel path.

### Congestion control
- **Default in Chrome: GCC (Google Congestion Control), send-side, driven by `transport-cc`** — `http://www.ietf.org/id/draft-holmer-rmcat-transport-wide-cc-extensions-01` (`kTransportSequenceNumberUri`), offered sendrecv by default. Plus `goog-remb` for legacy receive-side estimation. You cannot swap the algorithm from JS.
- **SQP — Devdeep Ray et al., arXiv:2207.11857, July 2022, Google** (https://arxiv.org/abs/2207.11857; also research.google/pubs/...). Purpose-built for *"AR streaming and cloud gaming that need to stream high-bitrate compressed video with very low end-to-end frame delay."* Uses **frame-coupled, paced packet trains** to probe bandwidth and an **adaptive one-way-delay measurement** to recover from queuing; responds to congestion primarily by modulating **video bitrate** rather than pacing rate. Works on shallow-buffer links, competitive against queue-building flows. **Real A/B result on Google's AR streaming platform vs Copa: 27% (LTE) and 15% (Wi-Fi) more sessions with high bitrate *and* low frame delay.** This is the closest published match to Swoop's problem.
- **Salsify — Fouladi et al., NSDI '18, April 2018** (https://www.usenix.org/conference/nsdi18/presentation/fouladi). Tightly couples a **purely functional video codec** with the transport: encodes each frame at two quality levels from identical state, in parallel, and picks which one to send **after** knowing both compressed sizes and the current capacity estimate. Optimises per-frame compressed length and transmission time rather than long-run frame rate/bitrate. Beats FaceTime, Hangouts, Skype, and WebRTC (with and without SVC) on both delay and quality over variable paths. Won an IRTF ANRP award (IETF 111).
- BBR / NADA / Copa: BBR is TCP-oriented and builds a queue at the bottleneck by design in its probe phases — not ideal here. NADA is the IETF RMCAT delay-based alternative to GCC. **For Swoop, SQP's model — couple the probe to the frame, react by changing the encoder bitrate — is the right architecture**, and it's implementable on the host regardless of what the browser does, because the host controls the encoder.
- **WebTransport gives you *less* CC control than WebRTC in Chrome** (§1d): no `congestionControl` option, no `getStats()`, no `sendOrder`. So "switch to WebTransport to control congestion" is currently false on Chrome.

### Other pitfalls worth flagging
- **HEVC has no software fallback in Chrome** (`media_options.gni`). Always probe with `isConfigSupported` / `MediaCapabilities` and fall back to H.264.
- **Edge diverges from Chrome on WebRTC HEVC send** (MSEdgeExplainers #1314, May 2026) despite being Chromium.
- **`UpdateCurrentDelay`'s 100 ms/s ramp** means a one-off network hiccup that inflates the jitter estimate takes seconds to drain — unless you're on the zero-playout-delay path, which bypasses it entirely. Another argument for the extension.
- **`kMaxWaitForKeyFrame = 200 ms`, `kMaxWaitForFrame = 3 s`** (`video/video_receive_stream2.h:71-72`), scaled by the remote NACK history (`DetermineMaxWaitForFrame`, ×3 conversion factor). These govern how long the receiver waits before requesting a new keyframe.
- **Safari has no `pointerrawupdate`** (BCD: safari NO) and **no Pointer Lock on iOS at all**. A Safari/iPad Swoop client is a materially worse input experience.
- **`setHeaderExtensionsToNegotiate` is Chrome-only** (117+), so `abs-capture-time` telemetry is Chrome-only.

---

### What I could NOT verify / where sources conflict

1. **Safari specifics.** `webkit.org` and `bugs.webkit.org` were unreachable from this environment (ECONNRESET / connect timeout, both via WebFetch and curl); `developer.apple.com` release notes are a JS SPA that returns only a title. So: the **exact Safari version that shipped HEVC in WebRTC** is unverified — I only have Chrome's Intent to Ship (3 Mar 2025) asserting *"Safari already shipped HEVC in WebRTC"*. Same for Safari's WebCodecs HEVC config-support behaviour.
2. **crbug.com/436302044** (the open macOS WebCodecs H.264 buffering bug) — issues.chromium.org requires sign-in; current status unknown.
3. **`desynchronized` measured latency saving** — no published number found anywhere. The Chrome blog only cites the 50 ms hand-eye-coordination threshold as motivation.
4. **`SendInput` latency cost** — not documented by Microsoft; I found no primary measurement. The 0–65535 absolute-coordinate normalisation is documented on the `MOUSEINPUT` page, not the `SendInput` page I read — verify before implementing.
5. **rVFC support versions — CONFLICT.** A WebFetch summary of the MDN page claimed Chrome 123 / Firefox 126 / Safari 17.4. Raw MDN BCD JSON says **Chrome 83 / Firefox 132 / Safari 15.4**, and web.dev (Jan 2023) independently says 83 / 132 / 15.4. Use 83/132/15.4.
6. **`jitterBufferTarget` Chrome version — CONFLICT.** Intent to Ship says M123; chromestatus API and MDN BCD both say **M124**. Use 124.
7. **Jitter-buffer contribution — CONFLICT.** Transitive Robotics' breakdown puts it at ~10 ms; my reading of `timing.cc`/`jitter_estimator.cc` puts the receiver-side floor at ≥21 ms + decode; a field report says 80 ms in practice; a Medium post (unverified) claims "22–27 ms". These are probably measuring different subsets (some stats exclude decode + render delay). **Measure it in your own harness before designing around any of them.**
8. **Digital Foundry / Ars Technica cloud-gaming latency figures** are second-hand from search-result summaries; I did not reach the originals.
9. I could **not** find a first-party Chrome/WebRTC statement of a numeric "jitter buffer floor" — the numbers above are derived from source constants, which is stronger evidence but is my arithmetic, not a quoted figure.
10. **WebSearch budget was exhausted mid-task** (200/200), so the second half of the research was done via direct WebFetch and `curl`/`gh` against known primary sources. DuckDuckGo HTML/lite endpoints bot-block this environment. A few avenues I'd have liked to chase (Demuxed / Kranky Geek / RTC.ON talks on browser decode latency; published measurements of Chrome's zero-playout-delay path) went unexplored as a result.

---

### Five things I'd act on first for Swoop

1. **Emit the `playout-delay` RTP header extension (min=0, max≈100–200 ms) from the native host.** Single biggest win on the WebRTC path; already negotiated by default in Chrome; unlocks both the render-ASAP path and `LowLatencyVideoRendererAlgorithm`.
2. **Fix the bitstream, not just the decoder config**: no B-frames, and write `bitstream_restriction_flag=1, max_num_reorder_frames=0, max_dec_frame_buffering=max_num_ref_frames` into every SPS. Port `sps_vui_rewriter.cc`'s logic. This is what turns "hardware decoder holds 4–25 frames" into 1-in-1-out.
3. **Design for HEVC-optional.** Chrome has no software HEVC decoder; probe with `isConfigSupported`/`MediaCapabilities` and ship a proper H.264 path. AV1 hardware decode coverage is worse than HEVC's.
4. **Kill the two rAF quantisations on the input path**: `pointerrawupdate` + `getCoalescedEvents()` with per-event timestamps for mouse (Chrome/Firefox; Safari falls back to `pointermove`), and poll gamepads off a 4–8 ms timer rather than rAF. Use Pointer Lock with `unadjustedMovement: true`.
5. **Instrument before optimising**: negotiate `abs-capture-time` via `setHeaderExtensionsToNegotiate()` (Chrome), read `captureTime`/`receiveTime`/`processingDuration`/`expectedDisplayTime` from `requestVideoFrameCallback`, and pair with `video-timing` (on by default) for host-side encode/pacer stage timings. That gives you a real per-stage glass-to-glass breakdown instead of the conflicting published numbers.

**Scratchpad artefacts** (raw sources, if useful for follow-up): `<local scratchpad>\swoop-research\raw\` — contains the fetched WebRTC/Chromium source files, the WebCodecs spec text, and a `bcd.js` helper that dumps MDN browser-compat-data version tables for any API. Nothing in the Owlette repo was touched.



---

## PART 4 — LATENCY BUDGET: WINDOWS HOST → BROWSER CLIENT

### 4.0 How to think about it
Input-to-photon is a serial chain. At 60 fps every stage that is quantised to a frame costs **16.7 ms**, so the budget is really *a count of frame-intervals plus the network RTT*. The frame-quantised stages (host present phase, capture cadence, encoder pipeline depth, jitter buffer, decoder queue depth, browser compositor, display scanout) are where all the wins are. The sub-millisecond stages (color convert, packetize, `SendInput`) are noise — do not spend engineering there.

### 4.1 The budget — 1080p60, hardware encode + hardware decode, browser client

| # | Stage | Typical | Floor achievable | Notes / evidence |
|---|---|---|---|---|
| 0 | Browser input event → data channel `send()` | **1–8 ms**, or **up to 16.7 ms** if rAF-gated | ~1 ms | `pointermove` is delayed to the browser's frame cadence; `pointerrawupdate` is *"dispatched as soon and as frequently as the browser can produce them"* (Chrome 77, FF 148, **Safari NO**) [V]. Sub-frame precision comes from **`getCoalescedEvents()`** (Chrome 58, FF 59, Safari 18.2), not from the event type [V, MDN]. Gamepads are worse: `getGamepads()` is a snapshot-on-read API — Chromium samples internally at **4 ms (~250 Hz)** (`gamepad_provider.cc`) but you only see what you poll, so **poll off a 4–8 ms timer, never rAF** [V]. |
| 1 | Uplink network (client→host) | **½ RTT** | ½ RTT | Input packets are tiny — no pacing, no congestion control on them, and they should bypass any video queue. |
| 2 | Host input injection (`SendInput`) | **0.1–1 ms** | 0.1 ms | Cheap. The *application's* own response latency is not yours to control. |
| 3 | App renders → DWM presents the new desktop frame | **0–16.7 ms** (avg 8.3) | 0 | Pure sampling phase against the host's refresh. Only shrinks if the host runs >60 Hz. |
| 4 | **Capture** — DXGI `AcquireNextFrame` | **1–6 ms** | ~1 ms | Parsec reports "Host Video Capture" as a first-class metric [V]. DDA is pull-based and *accumulates* updates [V, MS Learn]; a tight acquire→encode→`ReleaseFrame` loop is the whole trick. |
| 5 | Color convert BGRA→NV12/P010, GPU shader | **0.2–1 ms** | 0.2 ms | Parsec: *"all color conversion on the GPU via pixel shaders"*, never touching system RAM [V]. DDA always hands you `B8G8R8A8_UNORM`, so this pass is mandatory [V]. |
| 6 | **Encode** — ULL tuning, CBR, no B-frames, no lookahead | **NVENC 5.8 ms · QSV ~11 ms · AMF 15.1 ms** | ~1 frame | Parsec fleet medians at 60 fps over >250k sessions [V]. Parsec's operational red line: *"When streaming 60fps, you don't want to go above 15ms"* [V]. |
| 7 | Packetize + pace onto the wire | **0.5–3 ms** | 0.5 ms | 1080p60 P-frame at 15 Mbps ≈ 31 kB ≈ 22 MTU packets. Pace over ~1–2 ms to avoid a burst drop; pacing over a whole frame interval costs you 16 ms. |
| 8 | **Downlink network (host→client)** | **½ RTT + serialization + queueing** | ½ RTT | The one stage you cannot engineer away. Last-mile bufferbloat is the usual killer — Parsec sends users to a bufferbloat test and recommends SQM [V]. |
| 9 | **Jitter buffer / reordering** | **WebRTC media track, default: ≈21 ms + p95 decode ⇒ ~26–36 ms floor on an ideal LAN. With sender-side `playout-delay` min=0: ~0 (render ASAP, 8 ms pacing). DataChannel + WebCodecs: 0, your choice.** | ~1 jitter σ | **The single biggest lever in a browser design.** Derived from libwebrtc `timing.h/.cc` + `jitter_estimator.cc`: `TargetDelay = max(min_playout_delay, jitter_delay + p95_decode + render_delay)` with `kDefaultRenderDelay = 10 ms` and `jitter_delay ≥ 1 ms + OPERATING_SYSTEM_JITTER 10 ms` [V]. And it drains at only **100 ms/s** (`kDelayMaxChangeMsPerS`) after a hiccup [V]. Parsec native: *"no buffers of any kind on video"* [V]. |
| 10 | **Decode** (hardware, in-browser) | **~1–3 ms** (HEVC/AV1, measured) up to **12 ms** — but **200 ms+ if the H.264 SPS lacks `bitstream_restriction`** | ~1 frame | Chrome's H.264 output-reorder buffer defaults to **~16 frames**; Windows Media Foundation's decoder *"has a default latency of about 25+ frames, and if configured for low-latency will still be around 8 frames"* (Jean-Yves Avenard, w3c/webcodecs#732, 2023-10-31) [V]. `optimizeForLatency: true` helps but does **not** override what the bitstream says — see 5.3b. |
| 11 | Render `VideoFrame` → canvas / WebGL / WebGPU | **0.3–2 ms** | 0.3 ms | Zero-copy upload from a `VideoFrame`; `desynchronized: true` on the 2D/WebGL context skips a compositor hop. |
| 12 | Browser compositor + client vsync | **16.7–33.3 ms at 60 Hz; 8.3–16.7 ms at 120 Hz** | ~1 vsync less with `desynchronized` | Not a guess — Chromium's own model. `video_frame_submitter.cc` sets `deadline_min = frame_time + interval`, `deadline_max = frame_time + 2*interval`, i.e. **1–2 vsync intervals** [V]. `desynchronized: true` *"tells the underlying system to skip as much compositing as it is able"* (Chrome 75+) [V] — **but no published measurement of how much it saves exists.** |
| 13 | Display scanout + panel processing/response | **~8 ms avg at 60 Hz** + 1–20 ms panel | ~4 ms on a 120–144 Hz panel | Scanout is 0 ms at the top edge, 8.3 ms at centre, 16.7 ms at the bottom of a 60 Hz panel [V, Blur Busters]. |

### 4.1b Cross-check against measured numbers from a real browser-client implementation

**[V]** `linckosz/moonlight-web` (v0.2.4, benches dated **04–07/09/2026**, RTX 5060 Ti, 1440p60 CBR 40 Mbit/s, Chrome, WebRTC DataChannel → WebCodecs → canvas) publishes the closest thing that exists to a measured version of the table above:

| Stage | Their measured value |
|---|---|
| Capture (DXGI, 1440p) | **0.06 ms** |
| Encode (NVENC P1 + ULL) | **3.40 ms** avg / 4.61 p95 / 5.12 p99 (P4 was 7.67 / 10.24 / 11.26 at the *same* QP 25) |
| Host total (capture→wire) | **5.5–6.8 ms** |
| Decode, HEVC `hvc1.1.144.L150` | **1.1 ms** avg / 2.5 p99 |
| Decode, AV1 | 0.9 / 2.4 |
| Decode, H.264 **with** `bitstream_restriction` | 0.9 / 2.7 |
| Decode, H.264 **without** it | **200.8 ms avg / 206.3 p99** ← see 5.3b |
| Render (canvas) | 0.4–0.6 ms avg |
| **"Displayed latency" total** | **7.4 ms (AV1) · 8.3 ms (H.264 fixed) · 9.2 ms (HEVC)** |
| Their headline glass-to-glass | *"Under **20 ms** over Wi-Fi on a LAN, ~**25 ms** over the Internet"* |
| Click-to-photon, fullscreen 720p→1440p | Canvas2D **30.3 ms** median / 36.8 p90; WebGPU-NIS 26.8 / 36.6 |
| Click-to-photon, **windowed** | Canvas2D **54.4 ms** median vs **`<video>` sink 90.0 ms** |

**[I] Three things this settles.**
1. **My per-stage estimates were conservative on the host and roughly right on the client.** Capture and encode are cheaper than I budgeted (sub-4 ms combined on a modern GPU with P1+ULL); the client-side compositor/scanout block is the dominant fixed cost, exactly as modelled.
2. **`<video>` costs 35–45 ms versus a canvas** in their measurements (90.0 vs 54.4 ms windowed). That is a bigger number than any codec or network tuning will recover, and it is the strongest single argument for the DataChannel + WebCodecs + canvas path over an RTP media track.
3. **The 50 ms end of the target is reachable — but only fullscreen, on a LAN, with a high-refresh client.** Their best fullscreen click-to-photon is 26.8–30.3 ms median on a LAN; windowed on the same machine is 54.4 ms. Add an internet RTT and you are at 55–75 ms. That matches my Part 4.3 conclusion from the other direction.

**[V] For contrast, measured jitter buffers in shipping WebRTC-media products:**
- **Google Stadia's own client**: jitter-buffer delay **58.42 ms at 720p (3.5 frames), 45.35 ms at 1080p (2.7 frames), 35.35 ms at 4K (2.1 frames)** — arXiv 2009.09786 (v1 2020-09-21; Computer Communications 188 (2022) 99–116). **[I] Stadia, with Google's own WebRTC team behind it, still ate 35–58 ms of receiver buffer. That is the floor you inherit if you use a media track.**
- **JetKVM**: receiver jitter **29.5 ms at 861 kb, 48.4 ms at 2256 kb, 119.0 ms at 4000 kb** (their own PR #1372 sweep, 2026-03-29) while decode was only 4.5–5.8 ms. **[I] Their latency is a buffering problem, not an encode problem.**
- **GeForce NOW, measured**: client-side latency under 20 ms **~90% of the time on the native app vs ~70% in the browser** (arXiv 2401.06366v2, 2024-01-12). That ~20-point gap is the price of the browser as of 2024 — and it is exactly what WebCodecs closes.

### 4.2 Roll-ups

**[I] Best realistic case — browser client, DataChannel + WebCodecs, NVENC host, 1080p60, wired, 10 ms RTT:**
1 (input) + 5 (½RTT) + 0.5 (inject) + 8 (host present phase) + 2 (capture) + 0.5 (convert) + 6 (encode) + 1 (packetize) + 5 (½RTT) + 2 (jitter) + 5 (decode) + 1 (render) + 12 (compositor/vsync) + 8 (scanout) ≈ **57 ms**.

**[I] Same design, 40 ms-RTT internet path:** +30 ms ⇒ ≈ **87 ms**. Still inside target.

**[I] Same design on a plain WebRTC media track with Chrome's default jitter buffer:** add tens of ms ⇒ **~100–150 ms** even at 10 ms RTT. This is why a naive `RTCPeerConnection` video track cannot hit the target and Parsec's DataChannel architecture can.

**[I] 4K60 deltas:** capture ×~2 (2–10 ms), convert ×~4 (1–3 ms), encode ×~2 (NVENC ~10–14 ms), decode ×~2 (8–20 ms), packetize ×~4 (a 4K P-frame at 40 Mbps ≈ 83 kB ≈ 58 packets). Net **+20 to +35 ms** over 1080p. 4K60 to a browser inside 100 ms needs a wired client, a modern hardware HEVC/AV1 decoder, and ≤30 ms RTT. Default multi-viewer sessions to 1080p/1440p; make 4K an explicit quality mode.

### 4.3 What "50–100 ms input-to-photon" demands of the network

**[I]** The fixed, non-network cost of a well-built browser pipeline at 1080p60 is **~45–55 ms**, because four unavoidable frame-quantised stages (host present phase ~8, encode ~6, decode ~5, compositor + scanout ~20) already total ~40 ms before a packet moves. Therefore:

- **100 ms ceiling ⇒ RTT budget ≈ 40–45 ms**, with ~10 ms reserved for jitter. That is roughly continental distance (US-East↔US-Central, London↔Frankfurt).
- **50 ms target ⇒ RTT budget ≈ 5 ms** — LAN or same-metro only, and only with a 120 Hz+ client display and a compositor-bypassing render path. **The 50 ms end of the stated target is not reachable over a general internet path to a browser.** Put that in the design doc rather than discovering it in QA.
- **A TURN relay roughly doubles the geographic penalty** unless it sits on the great-circle path. Relay placement is a latency *feature*, not an ops detail — which is exactly why Parsec's `network_fast_relay_ping` signals all relays at once and takes the first that answers [V].
- **Jitter, not mean RTT, is what forces buffering.** 30 ms RTT with 2 ms jitter beats 20 ms RTT with 15 ms jitter, because the latter forces you to buffer or drop. Instrument p99 inter-arrival, not just ping.
- **[I] At 60 fps a 16.7 ms frame interval is itself ~1/3 of a 50 ms budget.** If the product ever needs to feel truly local, the lever is host *and* client refresh rate (120 Hz halves three of the four fixed stages), not more network engineering.


---

## PART 5 — LESSONS AND PITFALLS

### 5.1 The jitter buffer is the biggest single decision

- **[V]** Parsec native: *"Parsec has no buffers of any kind on video."* They pay for that with a predictive congestion controller that tries to *prevent* the loss rather than absorb it.
- **[V]** A WebRTC **media track** hands the jitter buffer to the user agent. Chrome exposes `RTCRtpReceiver.jitterBufferTarget` (enabled by default **M124**, also Firefox; **absent in Safari**) whose own spec summary says it *"influences the amount of buffering done by the user agent, which in turn affects retransmissions and packet loss recovery… control the tradeoff between playout delay and the risk of running out of … frames due to network jitter."*
- **[I] Conclusion:** on a media track you are *negotiating* with the browser about latency. On a DataChannel + WebCodecs you *own* it. For a 50–100 ms target, own it. Set your own target = measured p95 inter-arrival jitter + one frame, recomputed continuously, and clamp it to a small ceiling (e.g. 30 ms) so a bad network degrades into dropped frames rather than growing lag.
- **[I]** Never let the *audio* buffer set the video latency. Parsec buys audio robustness with 50–100 ms of buffer [V, `client_audio_min/max_buffer_ms`] while running video with none. Run them as independent clocks and accept lip-sync error on the desktop use case — nobody watches lips on a kiosk.

### 5.2 Presentation scheduling — free latency most implementations give away

- **[V]** Parsec's own web client draws decoded frames inside `requestAnimationFrame` (verified in the shipped bundle). That defers every frame to the next vsync tick: **up to 16.7 ms, average ~8 ms at 60 Hz, for nothing.**
- **[V]** `requestVideoFrameCallback` (Chrome 83, Safari 15.4, Firefox 132; Baseline 2024-10-29) exposes `expectedDisplayTime`, `presentationTime`, `presentedFrames` and `processingDuration`.
- **[V]** `desynchronized: true` 2D canvas: Chrome 81, Edge 79, **Safari 15**; **not supported in Firefox**. Desynchronized WebGL/WebGL2 is Chromium-only.
- **[I] Policy:** present on the decoder's output callback into a `desynchronized` surface where available; use rVFC's `expectedDisplayTime` and `presentedFrames` to *measure* drops and display phase, not to schedule. On Firefox, accept the extra frame and report it in telemetry so it is visible rather than mysterious.

### 5.3 Hardware decoder queue depth

- **[V]** `VideoDecoderConfig.optimizeForLatency` exists precisely for this: *"a hint that the selected decoder should be optimized to **minimize the number of `EncodedVideoChunk` objects that have to be decoded before a `VideoFrame` is output**"* (MDN). Parsec sets it, along with `hardwareAcceleration: "prefer-hardware"` [V, shipped bundle].
- **[I]** The failure mode is silent: a Media Foundation or VideoToolbox decoder that buffers N frames before emitting one adds N×16.7 ms and *looks perfectly smooth*. It only shows up as input lag. Instrument submit→output per frame (Parsec's client computes exactly this EWMA [V]) and alarm if it exceeds ~1.5 frame intervals.
- **[I]** Encoder side has the mirror problem: **no B-frames, no lookahead, no multi-pass**. Parsec's own UI encodes this as `encoder_min_qp` where the "Highest Quality" value *"enables multi-pass encoding"* [V] — i.e. multi-pass is explicitly the non-latency mode.

### 5.3b ⚠ THE SINGLE HIGHEST-VALUE FINDING: H.264 SPS `bitstream_restriction`

**[V]** `linckosz/moonlight-web`, measured **2026-09-04**, `NvencEncoder.cpp` (and documented in `docs/bench-native-host.md` §6):

> NVENC's H.264 SPS carries **no `bitstream_restriction` VUI block by default**. Without `max_num_reorder_frames`, **Chrome's D3D11 H.264 decoder holds an entire DPB before displaying — about a dozen frames at 1440p60 — on a stream that contains no B-frames at all.**

| H.264 1440p60, Chrome, DataChannel→WebCodecs | decode avg / p99 | displayed latency |
|---|---|---|
| Before fix | **200.8 / 206.3 ms** | **208 ms** |
| After `h264VUIParameters.bitstreamRestrictionFlag = 1` | 0.9 / 2.7 ms | **8.3 ms** |

**HEVC already emits it by default; H.264 does not.**

**[I] This is a 200 ms landmine sitting directly in Swoop's default path** (H.264 is the compatibility floor for Firefox and for any client without hardware HEVC). It is one field. It would present as "our browser client is inexplicably laggy and no profiler shows why", and `optimizeForLatency: true` does **not** rescue it — the decoder is obeying what the bitstream told it. Set `bitstreamRestrictionFlag = 1` with `max_num_reorder_frames = 0` and `max_dec_frame_buffering = 0` on every H.264 stream, and add an automated check that the emitted SPS contains it.

### 5.3c The receiver jitter buffer ratchets — and only the *sender* can un-ratchet it

**[V]** JetKVM, `internal/playoutdelay/interceptor.go`, **PR #1475 merged 2026-05-22**, header comment verbatim:
> *"Chrome's adaptive jitter buffer is one-way: it grows when packet timing gets jittery … and **stubbornly refuses to shrink back**, leaving the 'Playback Delay' graph stuck at hundreds of milliseconds until the page is reloaded. **Receiver-side knobs like `jitterBufferTarget` / `playoutDelayHint` / `setMinimumJitterBufferDelay` all cap the steady-state floor but cannot pull a ratcheted buffer back down.** The playout-delay extension is the sender-side counterpart… Chrome honours it as an **authoritative override** of its adaptive logic. We send min=max=0 on every video packet, which keeps the receiver pinned at the absolute floor."*

**[V]** The extension itself — `http://www.webrtc.org/experiments/rtp-hdrext/playout-delay`, SDP name `playout-delay`; 3 bytes of data, **12 bits min + 12 bits max, 10 ms granularity, range 0–40,950 ms**; `Playout delay = ExpectedRenderTime(frame) − ExpectedCaptureTime(frame)`. Its own spec text names the use case: *"**Interactive streaming (gaming, remote access)** … the RTP sender would like to disable all smoothing at receiver (**min delay = max delay = 0**)."* The sender MAY stop sending it once RTCP confirms receipt.
`MrCreativ3001/moonlight-web-stream` stamps `PlayoutDelayExtension { min_delay: 0, max_delay: 0 }` on **every** RTP packet.

**[V] But the counter-warning is equally load-bearing** — selkies-project/selkies-gstreamer issue #157 (opened 2024-05-25, closed by PR #254 merged 2026-07-14) explicitly warns against setting **receiver-side** `jitterBufferTarget` / `playoutDelayHint` to zero: *"causes stutter if the buffer wants to be bigger, but it's constantly forced down to 0 (most notably in higher resolutions)."*

**[V] ⚠ Important refinement over JetKVM's choice, from reading libwebrtc/Blink source: use `min=0, max>0 (≤500 ms)`, not `min=max=0`.** The extension flips *two independent* mechanisms, and only the first fires at max=0:
1. `timing.cc:282` — `UseLowLatencyRendering()` returns true when `min_playout_delay_.IsZero() && max_playout_delay_ <= kLowLatencyStreamMaxPlayoutDelayThreshold (500 ms)`, and `RenderTimeInternal()` then returns `Timestamp::Zero()` = *"render as soon as possible."* Frames are paced into the decoder at **`kZeroPlayoutDelayDefaultMinPacing = 8 ms`** minimum unless too many are queued. **This fires for max=0 too.**
2. `video_receive_stream2.cc:1125-1136` — **only when `frame_minimum_playout_delay_ == 0` AND `frame_maximum_playout_delay_ > 0`** does it compute `max_composition_delay_in_frames` and set it on the frame metadata. Blink's `video_renderer_algorithm_wrapper.cc:30-43` then swaps `VideoRendererAlgorithm` for **`LowLatencyVideoRendererAlgorithm`**, which drains a backlog by rendering **2× frames per vsync**, hard-drops above `kMaxPostDecodeQueueSize = 7`, and shaves the steady-state queue via `kReduceSteadyThreshold = 10`. **This does NOT fire at max=0.**

**[I] So JetKVM's `min=max=0` gets render-ASAP but leaves the compositor on the default pacing algorithm.** Setting `min=0, max≈100–200 ms` gets both. That is a free improvement over the best-known published practice.

**[V] And `jitterBufferTarget` really is near-useless for video.** `RTCRtpReceiverImpl::SetJitterBufferMinimumDelay()` → `VideoReceiveStream2::SetBaseMinimumPlayoutDelayMs()` only sets `base_minimum_playout_delay_`, one of three candidate **minimums** — it can raise the floor, never lower it below `jitter + decode + render`. Henrik Boström (Chrome WebRTC), W3C public-webrtc list, **12 Apr 2023**: on audio the hint *"is affecting the target jitter buffer"*; on video it *"is not affecting the jitter buffer directly, but rather the render timestamp being clamped within the min/max delay."*

**[I] Rule: sender-side `playout-delay` with min=0 and max≈100–200 ms, yes. Receiver-side `jitterBufferTarget = 0`, no.** And note this whole problem only exists on the media-track path — on DataChannel + WebCodecs there is no browser jitter buffer to ratchet in the first place.

### 5.3d The IDR spiral

**[V]** `linckosz/moonlight-web` wiki ch.5: the backend **throttles and coalesces IDR requests with a 250–500 ms cooldown** and a sticky `m_AwaitingIdr` flag, with exponential backoff on both ends, *"otherwise mobile networks enter an IDR spiral."* The frontend detects `frameId` gaps and **requests an IDR rather than reordering** — *"a frontend reorder buffer was tried and removed — it causes IDR floods and latency."* JetKVM's opposite choice (a real IDR every ~0.5 s at 4 Mbps VBR) is one of the reasons its bitrate overshoots target by 2.3×.

### 5.3e Two more measured traps from the same project

**[V] Audio must not ride a DataChannel.** *"The ordered audio DataChannel this replaced head-of-line-blocked on packet loss (periodic ~0.5 s dropouts); the browser's NetEq conceals the loss instead."* Audio is always a real RTP Opus track. Also: SDP must carry `stereo=1;sprop-stereo=1` or *"libwebrtc instantiates a **mono** decoder and downmixes (L+R)/2 — ~6 dB quieter"*, and RTP timestamps must advance by the negotiated Opus frame size, *"never by arrival time — an arrival-time clock makes NetEq time-stretch and the audio turns robotic."*
**[I] So the right split is: video on an unreliable DataChannel (you own the loss policy), audio on an RTP track (NetEq's concealment is genuinely better than anything you will write).** That is the opposite of Parsec's web client, which puts both on data channels.

**[V] Frame pacing is opt-in for a reason.** Their `FramePacer` (`mw_pacing=1`) sizes its reserve at the **p95 of per-frame excess transit** with a **hard cap of 25 ms** — *"past ~1.5 frames the added lag hurts a shooter more than the judder it removes"* — and they document a shipped bug where the reserve pinned at the 24.6 ms cap against a 2.9 ms measured tail. Default behaviour is **no dejitter buffer at all: present on decode, drop to the freshest frame.**

### 5.3f ⚠ OPEN RISK: macOS WebCodecs H.264 buffering on a *static* desktop

**[V]** w3c/webcodecs issue **#899**, opened **2025-07-23, still open**: ~**3-second** decode delay for H.264 (`avc1.64001F`, 1440×900) in WebCodecs on macOS, with `optimizeForLatency: true`. The reporter then applied the full SPS fix (`max_num_ref_frames=1`, `bitstream_restriction_flag=1`, `max_num_reorder_frames=0`, `max_dec_frame_buffering=1`) and reported **no improvement**: still 2–3 s on a **static desktop**, dropping to a few hundred ms only when the screen was busy. Same on Chrome *and* Firefox. `hardwareAcceleration: "prefer-software"` worked in all cases. Dale Curtis (Chrome media, 2025-08-04): *"Chrome's code definitely doesn't buffer a constant number of frames — we have cases of 1-in-1-out working when the bitstream is setup correctly."* Tracked as **crbug.com/436302044**; current status **unverified** (issues.chromium.org requires sign-in).

**[I] This is the most serious unresolved risk in the whole plan, and it lands precisely on Swoop's use case.** A fleet-management viewer looks at *static* screens most of the time — dashboards, kiosks, idle desktops — on a Mac, in a browser. Mitigations to design in now, before it bites:
- **Never let the encoder go fully idle.** Send a frame at a floor rate (e.g. 5–10 fps) even when nothing changes. This is what Parsec's `host_full_fps` / "Constant FPS" setting is for [V], and it is cheap because a no-change P-frame is tiny.
- **Prefer HEVC on macOS** (Safari and Chrome both have VideoToolbox HEVC; the reported bug is H.264-specific) and keep H.264 as the fallback.
- **Instrument decode submit→output per frame** (the EWMA Parsec's client computes [V]) and, if it exceeds a threshold, fall back — to `prefer-software`, or to a lower resolution, or to a keyframe nudge.
- **Test this on day one on a Mac against a genuinely idle Windows desktop.** It will not reproduce on a busy screen.

### 5.4 Never respond to loss with a keyframe

Covered in 6.3. Summary of the verified basis: NVIDIA's own programming guide names reference-frame invalidation *"the recommended error resiliency feature for low latency applications"*, provides `NvEncInvalidateRefFrames`, long-term references (`enableLTR`), and intra refresh (`enableIntraRefresh`/`intraRefreshPeriod`/`intraRefreshCnt`) for *"infinite GOP"* operation, and recommends a large DPB so old references survive invalidation [V].

### 5.5 Transport-layer traps

- **[V] SCTP defaults are reliable + ordered.** Parsec's own web client leaves `createDataChannel` at defaults, which means head-of-line blocking on the video channel. Use `{ordered: false, maxRetransmits: 0}` (or a small `maxPacketLifeTime`) for video and keep a reliable ordered channel for control.
- **[V] Pre-negotiated channels** (`{negotiated: true, id: n}`) avoid the DCEP round trip. Parsec uses ids 0/1/2 for control/video/audio.
- **[V] STUN alone is not enough for a fleet.** Parsec's connectivity doc states outright that host and client *"must not be inside a 'Double NAT' or CGNAT network"*, and the web client's ICE config contains **no TURN**. Any product that must reach arbitrary corporate machines needs TURN as a designed path, not an afterthought.
- **[V] One public UDP port can serve many sessions.** Parsec's HPR *"relays many concurrent Parsec sessions through a single IP address / port configuration"* — a far easier firewall ask than a port range. Parsec's *non*-relay P2P mode, by contrast, burns one UDP port per guest sequentially [V].
- **[V] Bufferbloat on the user's own uplink is a first-order term.** Parsec's troubleshooting page sends users to a bufferbloat test and recommends SQM. **[I] A pacer that keeps the bottleneck queue empty (delay-based, not loss-based, congestion control) is worth more than any codec tweak on a residential link.**

### 5.6 Host-side traps that only show up in the field (all [V], Parsec support docs)

- **G-Sync/VRR on the host raises encode latency** — Parsec explicitly tells users to disable it.
- **Specific NVIDIA driver versions cause encode-latency spikes and capture issues**; Parsec names 472.12 as a known-good fallback. **[I] Pin/validate driver versions in a fleet product and expose the encode-latency metric so this is diagnosable.**
- **Hybrid-GPU laptops:** *"Parsec needs to use whichever GPU is directly plugged into the display you want to capture"* — usually the iGPU for the built-in panel, not the discrete GPU. Getting this wrong means capture fails or falls back to a slow path.
- **Fullscreen vs windowed vs borderless changes encode latency** in some Vulkan titles.
- **Third-party "network optimizer" software** (Lenovo Vantage, HP Smart are both named) causes intermittent stutters.
- **`server_max_clients` bandwidth is divided, not adapted** — 30 Mbps ÷ 5 guests = 6 Mbps each.

### 5.7 Measurement discipline

- **[V]** Parsec exposes capture / encode / decode / frame-time / RTT / bitrate / decoder-type / codec / chroma in a user-visible overlay, plus explicit "decode too slow" and "network congested" warning states.
- **[V] ⚠ Parsec's own web client reports `networkLatency = 0`** — it never measures RTT. **[I] Do not repeat this.** Without RTT in the browser you cannot pick FEC vs NACK, cannot size a buffer, and cannot tell a user whether their problem is the network or their laptop.
- **[V] Be skeptical of published "encoder latency" benchmarks.** The 2025 arXiv 4K study reports NVENC at "6–7 frames" — but its methodology is **OBS → SRS WebRTC server → player, measured by photographing two monitors**. That is ~10× Parsec's 5.8 ms measured NVENC median. **[I] Whole-pipeline numbers from off-the-shelf tooling are not encoder numbers, and quoting them will mislead your own design reviews.**


---

## PART 6 — SYNTHESIS: WHAT SWOOP SHOULD COPY, AVOID, AND DO DIFFERENTLY

Everything here is **[I]** unless it restates a cited fact.

### 6.0 Before anything else: read `linckosz/moonlight-web`

**[V]** It is a native Windows/Linux/macOS host streaming to a browser over WebRTC DataChannels into WebCodecs, GPLv3, one author, **with a published measurement campaign** (`docs/bench-native-host.md`, campaigns dated 04–07/09/2026; `docs/wiki/05-Streaming-and-Transports.md`; `docs/wiki/15-Client-Presentation-Benchmarks.md`). Claimed *"under 20 ms glass-to-glass over Wi-Fi on a LAN, ~25 ms over the Internet"*; measured 0.06 ms capture, 3.40 ms NVENC encode, ~1 ms HEVC decode, 7.4–9.2 ms "displayed latency".

**[I] This changes the shape of the project.** Most of the hard, non-obvious decisions Swoop faces — DataChannel framing, IDR throttling, backpressure watermarks, audio-on-RTP-not-DataChannel, the SPS fix, the pacer's 25 ms cap, the `<video>`-vs-canvas question — have already been made there, measured, and documented, sometimes with the failed attempt written up next to the fix. **Budget a day to read its wiki and benches before the design doc is finalised.** Note the licence: **GPLv3**, so it is a reference to learn from, not code to vendor into a commercial product.

**[I] Its transport ladder is also a ready-made fallback design** [V, wiki ch.5]: `webrtc-dc-udp` (default: video+input on SCTP DataChannels, audio on an RTP track, H.264/HEVC/AV1, canvas) → `webrtc-dc-tcp` (ICE-TCP for UDP-hostile networks) → `webrtc-media-udp` (RTP tracks into `<video>`, H.264 only, browser-managed jitter/FEC/PLC) → `webrtc-media-tcp` → `wss` (everything on one WebSocket, worst latency). **Copy that ladder.** It degrades along the right axis: codec choice and latency first, connectivity last.

### 6.1 The architecture to copy (from Parsec, verified in their shipped bundle)

1. **One host encoder, one elementary stream, two carriers.** Parsec's SDK models this explicitly — `PROTO_MODE_BUD` vs `PROTO_MODE_SCTP`, `CONTAINER_PARSEC` vs `CONTAINER_MP4` [V]. The browser client is not a different product; it is the same stream over a different datagram carrier. Do not build "a WebRTC pipeline" and "a native pipeline".
2. **Video on a data channel, not a media track.** This is the decision that makes 50–100 ms possible in a browser. You own the buffer, the pacing, the loss policy and the frame-to-display scheduling. On a media track, libwebrtc owns all four and its defaults are tuned for conferencing.
3. **Pre-negotiated data channels with fixed IDs** (`{negotiated: true, id: n}`) so the channels are live the moment DTLS/SCTP completes [V, Parsec ships exactly this with control=0, video=1, audio=2].
4. **Cursor out-of-band.** DDA hands you the pointer shape and position separately from the frame [V, MS Learn], and Parsec forwards them as their own message type with `positionX/positionY/hotX/hotY/relative/hidden` [V]. Draw the cursor client-side; it decouples the most latency-visible thing on screen from the video pipeline entirely.
5. **Per-guest permission triple** — `{gamepad, keyboard, mouse}` set per guest, plus an exclusive-input mode where the mouse is a single token the local user can always preempt [V, `ParsecPermissions` + `host_exclusive_input`]. For a fleet product this is "many watchers, one driver, operator can always seize".
6. **Ship the telemetry to the user.** Capture ms, encode ms, decode ms, frame time, RTT, bitrate, decoder type, codec, chroma, plus explicit warning states for "decode too slow" and "network congested" [V, Parsec overlay]. This is why Parsec support can triage; without it every latency complaint is unfalsifiable.
7. **Virtual display driver as the enabling dependency** for headless hosts, multi-monitor, privacy mode and auto-lock-on-last-disconnect [V]. Budget for a signed driver in the installer.

### 6.2 The five things to do better than Parsec (all verified gaps)

| Parsec's choice | Why it costs latency | Swoop's choice |
|---|---|---|
| Video data channel left at SCTP defaults (**reliable, ordered, unbounded retransmit**) [V] | A link freeze replays seconds-old frames ahead of the keyframe | **`{ordered: true, maxPacketLifeTime: 500}`** — what `moonlight-web` ships, deliberately: *"a lifetime, not a retransmit count: a link freeze must not replay second-old frames ahead of the keyframe"* [V]. Keep ordering (reassembly stays trivial), bound the retransmit window in **time**. Detect `frameId` gaps in the client and request an IDR rather than building a reorder buffer — *"a frontend reorder buffer was tried and removed — it causes IDR floods and latency"* [V] |
| Decoded frames drawn via `drawImage` on a 2D canvas **inside `requestAnimationFrame`** [V] | Up to a full client frame (avg ~8 ms at 60 Hz) of pure waiting | Render on the `VideoDecoder` output callback to a `desynchronized: true` canvas or a WebGPU external texture; use `requestVideoFrameCallback`'s `expectedDisplayTime` for *measurement*, not scheduling |
| `codec: "avc1.42001e"` hardcoded — **H.264 Baseline only** [V] | ~2x the bitrate of HEVC for equal quality [V, Parsec's own docs]; no 4:4:4, no 10-bit | Negotiate per viewer: HEVC where `VideoDecoder.isConfigSupported` says hardware is available (Chrome ≥130 WebCodecs / ≥136 WebRTC, Safari shipped [V]), H.264 otherwise |
| **No TURN in the browser ICE config**; docs require "not CGNAT, not double NAT" [V] | Fleet machines behind corporate NAT and CGNAT simply cannot connect | TURN as a first-class path, with relays raced by RTT — steal `network_fast_relay_ping`'s "signal all, take the first reply" [V] |
| Plain `mousemove`, no coalesced/raw events, no `unadjustedMovement` [V] | Mouse capped at browser frame rate and passed through OS acceleration | `pointerrawupdate` + `getCoalescedEvents()`; `requestPointerLock({unadjustedMovement: true})`; send on the event, never on rAF |

### 6.3 Loss recovery: the design that keeps latency flat

**[V] Facts:** Parsec runs *"no buffers of any kind on video"* and relies on predictive congestion control. NVENC exposes `NvEncInvalidateRefFrames`, `enableLTR`, and intra refresh (`enableIntraRefresh`/`intraRefreshPeriod`/`intraRefreshCnt`), and NVIDIA calls reference-frame invalidation *"the recommended error resiliency feature for low latency applications"*, recommending a **large DPB** so old references survive invalidation.

**[I] The policy that follows:**
- **Never send a keyframe as the loss response.** A 1080p IDR is 5–15× a P-frame; at a constrained bitrate it takes several frame intervals to drain and *causes* the next congestion event. This is the classic remote-desktop death spiral: loss → keyframe → burst → more loss.
- **Feedback loop instead:** client detects a gap (sequence numbers on the video channel) → sends a tiny invalidation message on the control channel → host calls `NvEncInvalidateRefFrames` for the affected frames → encoder re-references an older *known-good* long-term reference. Cost: one RTT and a slightly larger P-frame. Compare to a keyframe: several frame intervals plus a bitrate spike.
- **Run a large DPB + periodic LTR marking** so there is always a known-good anchor within ~1 s.
- **Enable intra refresh as the background safety net** for the case where the feedback loop itself is broken (e.g. the control channel is congested). Infinite GOP + rolling intra refresh gives you keyframe-free recovery with a flat bitrate profile — which is exactly what a fixed-latency pipeline needs.
- **FEC vs retransmit is an RTT question.** Below ~20 ms RTT a NACK costs less than the bandwidth tax of useful FEC; above ~60 ms RTT a retransmit is more than a frame late and FEC (or invalidation) is the only option that doesn't stall. **[I] Make it adaptive on measured RTT, and note that Parsec's web client can't do this at all because it reports `networkLatency = 0` [V].**

### 6.4 Multi-viewer

**[V] What Parsec does:** one encoder; `encoderMaxBitrate` is *"split between guests"*; `maxGuests`/`server_max_clients` default **20**; their docs warn 30 Mbps ÷ 5 guests = 6 Mbps each. HEVC is negotiated down to the *worst* participant — *"the stream will revert to H.264 for everyone"*.

**[I] Why that is not good enough for Swoop:**
- One slow viewer drags codec choice and bitrate for everyone.
- Bitrate division is not the same as rate adaptation: a 6 Mbps share on a 100 Mbps link is wasted; a 6 Mbps share on a 4 Mbps link still congests.

**[I] What to do instead, in increasing order of cost:**
1. **Tier 1 (cheap, do first): per-viewer codec, shared bitrate.** Run two encoder instances at most — one HEVC, one H.264 — and route viewers to whichever they can hardware-decode. NVENC can run several concurrent sessions; the cost is GPU encode slots, not latency. This alone removes the "revert to H.264 for everyone" cliff.
2. **Tier 2: temporal layers / SVC.** Encode with a temporal-scalability pattern so a congested viewer can be served a decimated subset of the same bitstream without a second encode. Chrome has shipped WebRTC SVC extensions since M111 [V], but on a DataChannel you are doing the layer dropping yourself anyway — which is simpler, not harder.
3. **Tier 3: simulcast (N independent encodes).** Only worth it when viewers have genuinely divergent resolutions (e.g. a 4K operator plus phone viewers).
4. **Always: per-viewer congestion control on a shared base stream.** Each viewer's pacer decides what it can take; the encoder targets the *best* viewer's capacity, not the aggregate or the worst.
5. **[I] Watch the NAT port cost.** Parsec burns **one UDP port per concurrent guest, sequentially** [V]. A WebRTC/ICE design avoids this, but the per-viewer DTLS/SCTP association is still real CPU on the host — budget it.

**⚠ Constraint on per-viewer encoding: NVENC concurrent-session limits.** NVIDIA's own Video Encode/Decode GPU Support Matrix (https://developer.nvidia.com/video-encode-and-decode-gpu-support-matrix-new, fetched 2026-09-17) caps **concurrent NVENC sessions on GeForce consumer cards** while **Quadro/professional cards are "Unrestricted"**. My extraction read the current cap as **12** for Turing→Blackwell consumer parts, and 1–3 NVENC units per die on Ada/Blackwell vs 1 on Ampere/Turing.
**⚠ Confidence note:** the same extraction also claimed HEVC 4:4:4 and 10-bit encode are Ada/Blackwell-only, which **contradicts Parsec's own documented host requirement of NVIDIA Pascal (GTX 1000) or newer for 4:4:4 HEVC encode** [V]. The matrix is a wide HTML table and the summariser very likely misaligned columns. **Treat the per-generation codec rows as UNVERIFIED and re-read the matrix by hand before relying on them.** The session-limit *shape* (GeForce capped, professional unrestricted) is the part I would act on; the exact number has changed several times across driver releases.
**[I] Practical takeaway:** a "two encodes, HEVC + H.264" design is safely inside any plausible cap. A "one encode per viewer" design on a consumer GPU is not — and on fleet hardware (often iGPU or a low-end dGPU) it is definitely not. Design for a small fixed number of encoder instances and do the rest with layer dropping.

### 6.5 Transport: what to actually build

**[I] Recommendation: WebRTC `RTCPeerConnection` used purely as an ICE + DTLS + SCTP datagram carrier, with three pre-negotiated data channels, unordered/unreliable for video.**
- You get for free: ICE (STUN + TURN + hole punching), DTLS encryption, and browser-native NAT traversal — all the parts Parsec had to hand-roll on the host side.
- You give up: libwebrtc's congestion control (`transport-cc`/GCC) and its jitter buffer. Both are things you *want* to give up for this workload — GCC is tuned for conferencing and will not converge the way an interactive desktop needs.
- You must build: your own pacer + congestion controller on the host, your own sequencing/gap detection, your own loss policy (6.3), and your own presentation scheduler.
- **WebTransport is not a substitute, and the "but you get QUIC congestion control" argument is false on Chrome.** It is client↔server only (no P2P). And per MDN BCD: `WebTransport.congestionControl` → **Chrome NO** (Firefox 114, Safari 26.4); the `congestionControl` constructor option → **Chrome NO**; `requireUnreliable` → **Chrome NO**; `sendOrder` → **Chrome NO**; `getStats()` → **Chrome NO**. Chromestatus lists the reliability/prioritisation/datagram-stream features as "Proposed" with no milestone. **[V]** So on the browser that matters most you cannot request low-latency CC, cannot read connection stats, and cannot prioritise streams — strictly *less* control than WebRTC. Also: UDP/443 is filtered on some networks and its reachability ceiling is below WebSocket's; DevTools does not show datagram payloads. **[I] Keep it as a possible third path (relay / multi-viewer fan-out), not as the transport.** One genuinely useful bit: `serverCertificateHashes` (Chrome 100+) lets a relay use a self-signed cert with ≤14-day validity — no public CA needed.

**[I] Congestion control: build SQP's model, not GCC's.** Chrome's default is **GCC driven by `transport-cc`**, and you cannot swap it from JS [V]. The published algorithm closest to this exact problem is **SQP** (Devdeep Ray et al., Google, arXiv:2207.11857, July 2022): frame-coupled paced packet trains for bandwidth probing, adaptive one-way-delay measurement to detect queuing, and **it responds to congestion by modulating the video bitrate rather than the pacing rate** — which is precisely Parsec's *"ultra-responsive dynamic bitrate adjustment"* [V] described formally. Google's own A/B on their AR streaming platform reported **27% (LTE) and 15% (Wi-Fi) more sessions with both high bitrate and low frame delay** versus Copa. **Salsify** (Fouladi et al., NSDI '18) is the other reference point: encode each frame at two qualities in parallel and choose *after* seeing both compressed sizes and the current capacity estimate. Both are implementable entirely on the host, independent of what the browser does, because the host owns the encoder — which is the whole reason the DataChannel path is worth its cost.
- **Do not use a WebRTC media track** unless a specific client (Safari without WebCodecs coverage, say) forces it — and if you do, set `jitterBufferTarget` to the smallest value the UA accepts (Chrome ≥124, Firefox shipped; **not available in Safari** [V]).

### 6.5b The NVENC configuration two independent projects converged on

**[V]** Sunshine (`src/nvenc/nvenc_base.cpp`) and `moonlight-web` (`NvencEncoder.cpp`) arrived at essentially the same settings without copying each other. Take this as the starting config:

```
presetGUID              = P1                      // NOT P4 — see the QP note below
tuningInfo              = NV_ENC_TUNING_INFO_ULTRA_LOW_LATENCY
enablePTD               = 1
gopLength               = NVENC_INFINITE_GOPLENGTH
idrPeriod               = NVENC_INFINITE_GOPLENGTH   // IDR on demand only
frameIntervalP          = 1                       // no B-frames
rcParams.rateControlMode= NV_ENC_PARAMS_RC_CBR
rcParams.zeroReorderDelay = 1
rcParams.enableLookahead  = 0
rcParams.lowDelayKeyFrameScale = 1
rcParams.multiPass      = NV_ENC_TWO_PASS_QUARTER_RESOLUTION   // KEEP IT — see below
rcParams.vbvBufferSize  = bitrate / fps           // 1 frame, with a 1/60 s floor
rcParams.vbvInitialDelay= vbvBufferSize
repeatSPSPPS            = 1
sliceMode / sliceModeData = 3 / slicesPerFrame
DPB 4 frames, numRefL0 = NV_ENC_NUM_REF_FRAMES_1  // large DPB for RFI, 1 ref per frame
h264VUIParameters.bitstreamRestrictionFlag = 1    // ← the 208 ms → 8 ms fix, H.264 only
profileGUID = NV_ENC_H264_PROFILE_HIGH_444_GUID / NV_ENC_HEVC_PROFILE_FREXT_GUID when 4:4:4
```

**[V] Measured justifications (moonlight-web bench, RTX 5060 Ti, 1440p60 CBR 40 Mbit/s, game content):**
- **P1 vs P4 is free**: 3.40 ms vs 7.67 ms average encode **at identical QP 25**. On scrolling text P1 costs +5 QP (sharp high-contrast edges are what P4 predicts better) — so consider preset per content mode if text fidelity matters.
- **Do NOT disable the ULL preset's quarter-res multipass.** Turning it off saves 0.4–0.6 ms but *breaks the still-screen refinement burst*: single-pass RC on a picture that has just stopped moving never spends its budget and **QP stalls at 29 instead of reaching 8**. **[I] For a fleet product full of static dashboards, that is exactly the wrong trade.**
- **Temporal AQ does nothing.** **AMF pre-analysis kills the encoder session.** Intel `LowPower`/VDENC is a big win: HEVC 1080p60 **16.3 → 10.5 ms**, 1440p **21.4 → 13.4 ms**.
- **Intel oneVPL has no reference-frame invalidation** (`NumRefFrame = 1`) and **its bitrate cannot be raised above the init value** (`Reset` refuses). **[I] Plan a QSV path that re-initialises the encoder to change bitrate upward, or cap the initial bitrate high and rate-control by QP.**
- **4:4:4 needs the profile GUID set explicitly** — *"Without this NVENC accepts 4:4:4 input and encodes 4:2:0 from it"* [V]. NVENC does 4:4:4 for H.264 and HEVC, **never AV1**; AMF and oneVPL do no 4:4:4 at all.
- **DPB 4 / refL0 1**: *"Four frames of DPB let up to three consecutive lost frames be healed by an ordinary delta… the encode time is unchanged (measured: within noise at P1)."*
- **Split-frame encoding** (Sunshine `NV_ENC_SPLIT_AUTO_MODE`, default `driver_decides`, PR #4892 merged 2026-03-23) needs `NV_ENC_CAPS_NUM_ENCODER_ENGINES > 1` — Ada 4070 Ti and up. Not available on typical fleet hardware.

### 6.5c FEC vs retransmit — what the two camps actually do

**[V] Sunshine/Moonlight use Reed–Solomon FEC, on by default at 20%.** `fec_percentage=20` (client SDP `x-nv-vqos[0].fec.repairPercent = 20`, dropped to **5 at 4K** "to reduce stream overhead"); `minRequiredFecPackets = 2`; parity shards `= ceil(data_shards * pct / 100)`, raised to the minimum if too low; **max 4 FEC blocks per frame** (2 header bits), and if more are needed **FEC is disabled for that frame** ("should only happen for enormous frames — over 800 packets at 20%"). Moonlight reserves the overhead up front: `adjustedBitrate = bitrate * 0.80`. Client RTP queue waits `RTP_QUEUE_DELAY = 10 ms` for missing/reordered packets. Their SDP comment is telling: *"FEC must be enabled for proper packet sequencing."*

**[V] `moonlight-web` uses none**: its architecture line is literally *"zero-copy: capture → encode → fragment → DTLS → browser (no loopback, **no RTP, no FEC**)"* — it relies on SCTP's bounded retransmit plus gap-triggered IDR.

**[V] And WebRTC itself already encodes the answer as a constant.** `modules/video_coding/media_opt_util.h:46` / `.cc:105-122`:
```cpp
constexpr int64_t kLowRttNackMs = 20;
// Hybrid Nack FEC has three operational modes:
// 1. Low RTT (below kLowRttNackMs) - Nack only: Set FEC rate to zero.
// 2. High RTT (above _highRttNackMs) - FEC Only.
// 3. Medium RTT values - Hybrid mode: We will only nack the residual
//    following the decoding of the FEC.
```
**⇒ Google's own threshold is 20 ms RTT: below it, NACK only and zero FEC.**

**[V] A genuinely underused lever:** in `webrtc_video_engine.cc`, `flexfec-03` is **always offered as a receive codec** by Chrome (line 178), but Chrome only *sends* it behind the `WebRTC-FlexFEC-03-Advertised` / `WebRTC-FlexFEC-03` field trials (*"Never enable sending FlexFEC, unless we are in the experiment"*, line 1107). **So a native Swoop host CAN send flexfec-03 to a stock Chrome receiver even though Chrome will never send it to you.** `red`+`ulpfec` are also offered. Reed–Solomon and RaptorQ are not available on the WebRTC media path at all — those need the WebCodecs + DataChannel path.

**[I] Reconciling all of it:** FEC pays when you cannot afford a round trip (high RTT, or a media track with no application feedback channel). Bounded retransmit pays when RTT is small relative to a frame interval. Sunshine is designed for LAN-first *plus* arbitrary internet with no guaranteed feedback; moonlight-web has a reliable control channel and a 500 ms lifetime. **For Swoop: default to bounded retransmit + gap→IDR + reference-frame invalidation, and switch FEC on adaptively above ~20–30 ms RTT** — Google's own constant, and the point at which a NACK is already more than a frame late. Budget the FEC overhead **out of** the encoder's target bitrate the way Moonlight does (×0.80), not on top of it.

**[V] ⚠ And know what you do NOT get from the browser on a media track.** Searching the whole libwebrtc mirror, **RPSI is not implemented** — `rpsi` appears exactly once, as a comment example in `media/base/codec.h:47`. Chrome's default video RTCP feedback set (`AddDefaultFeedbackParams`) is **`goog-remb`, `transport-cc`, `ccm fir`, `nack`, `nack pli`**. RTCP Loss Notification (`lntf`), which carries `(last_decoded, last_received, decodability_flag)` — exactly the primitive reference-frame invalidation needs — is **VP8-only and behind the `WebRTC-RtcpLossNotification` field trial**, i.e. unavailable in stock Chrome.
**[I] So on a media track your only loss signals are NACK and "send me a whole keyframe". Reference-frame invalidation — the single best loss-recovery technique available to your host encoder — is only usable if you build your own feedback channel, which means the DataChannel path.** That is an independent, and to my mind decisive, argument for it.

### 6.5d Multi-viewer, as peers actually do it

**[V]** `moonlight-web` caps at **4 simultaneous viewers (owner + 3)** and **pins the quality ladder while a guest is connected** — *"the automatic ladder would relaunch your stream on the other slot to shave a few megabits, which on a jittery network means transitioning more than streaming."* Selkies enforces input authority server-side per viewer role/slot. Parsec splits one bitrate budget across up to 20 guests [V].
**[I] The lesson is the opposite of what you'd guess: with multiple viewers you should adapt *less*, not more.** Every renegotiation is a visible glitch for everyone. Pick a ladder rung on join, hold it, and let individual viewers drop frames rather than re-laddering the shared encode.

### 6.6 Host-side checklist (Windows)

- **Capture:** DXGI Desktop Duplication, tight `AcquireNextFrame`→encode→`ReleaseFrame` loop, short timeout, treat `DXGI_ERROR_ACCESS_LOST` as routine and re-create. Use dirty/move rects to skip encoding when nothing changed [V, MS Learn] — and to drive an "idle" mode that stops burning GPU and bandwidth on a static kiosk screen, which matters a lot for a fleet product.
- **Zero copy end to end:** DDA texture → compute/pixel shader BGRA→NV12 (or P010 for 10-bit) → NVENC input, never touching system RAM [V, Parsec's stated rule].
- **Encoder:** ULL tuning, CBR, **no B-frames, no lookahead, no multi-pass**, infinite GOP with intra refresh, `lowDelayKeyFrameScale` to damp I-frame bursts, large DPB + LTR for invalidation, and a **min-QP floor** as the primary "don't overshoot the channel" knob — Parsec's "Lowest Latency" preset is literally `encoder_min_qp=5` [V].
- **Slice/split output** so packetization can start before the frame is fully encoded.
- **Input injection:** `SendInput`, batched atomically per event group, with `GetAsyncKeyState` reconciliation and an explicit release-all on disconnect/blur/permission-revoke [V, MS docs + Parsec's `blur` forwarding].
- **Privilege:** a SYSTEM service plus a session-attached helper for the secure desktop. **Never trigger a UAC prompt from an unattended path** (existing Owlette guardrail).
- **Known host-side latency traps [V, Parsec support]:** G-Sync on the host raises encode latency; some NVIDIA driver versions cause encode-latency spikes; on hybrid-GPU laptops you must capture on the GPU that drives the target display; NVIDIA "maximum performance" power mode helps.

### 6.7 Beating JetKVM — and what "wide margin" means numerically

**[V]** JetKVM: RockChip **RV1106G3** (single-core ARM Cortex-A7) with a **Toshiba TC358743** HDMI→CSI bridge, 1080p60 max, H.264/H.265 auto-negotiated, streamed over WebRTC. Independently measured **≈98 ms click-to-photon on wired LAN**, of which **≈85 ms is the device itself** — WarpKVM, "JetKVM Review (2026)", https://warpkvm.com/blog/jetkvm-review, **July 17, 2026**.

**[I]** That 85 ms is *device-only*, on a LAN, before any internet RTT. A software host doing DDA + NVENC starts from Parsec's measured **5.8 ms median encode** and a capture stage of a few ms — an order of magnitude better — because it never pays for HDMI re-digitisation, a CSI bridge, or a 1 GHz Cortex-A7 running the encode and the network stack. **Swoop's structural advantages over any hardware KVM are: no HDMI round trip, a GPU ASIC encoder instead of a low-power SoC, and zero-copy from framebuffer to encoder.** Target: **≤40 ms device-side (capture→wire)**, versus JetKVM's ~85 ms, i.e. beat it by >2x on LAN and by more once the browser path is tuned. But note the honest caveat: **JetKVM works with no software on the target and survives a BIOS screen or a dead OS; Swoop cannot.** They are complements, not pure substitutes.



---

## PART 7 — WHAT I COULD NOT VERIFY, AND WHERE SOURCES CONFLICT

Listed so nobody treats these as settled.

### Could not verify
1. **Whether BUD uses FEC at all.** Parsec never mentions forward error correction in any public post. "No buffers of any kind on video" + "reliability semantics like TCP" + NVENC-style reference invalidation *implies* NACK/retransmit plus encoder-side recovery, but that is inference. No public source states the loss-recovery mechanism.
2. **Parsec's actual encoder parameters** beyond what the config file exposes. `encoder_min_qp`, `encoder_bitrate`, `encoder_fps`, H.265 on/off, 4:4:4 on/off and 10-bit on/off are documented; GOP length, slice count, whether they use intra refresh, DPB size, LTR usage and reference-invalidation behaviour are **not public**. The NVENC capabilities described in Part 1.2 are what the hardware offers, not confirmation that Parsec uses them.
3. **Parsec's congestion-control algorithm.** `network_cg_level` has three settings ("new sensitive" default, "new relaxed", "old algorithm") and the blog describes it as predictive, but the algorithm itself is undocumented. No public source names GCC, BBR, SQP, or anything else.
4. **Whether Parsec's per-guest encoding is truly one shared encode.** `encoderMaxBitrate` is documented as *"split between guests"* and "Add Screens" proves multiple concurrent encoder instances exist per *monitor* — but I found no source stating whether two guests on the same monitor with different capabilities get one stream or two.
5. **HEVC 4:4:4 in browser WebCodecs.** Chrome ships HEVC decode hardware-only; I could not find a primary source confirming whether `hev1.*` 4:4:4 profiles are exposed via `VideoDecoder.isConfigSupported` on any browser. **Test this empirically before designing around it.**
6. **`pointerrawupdate` and `getCoalescedEvents()` cross-browser support.** No entry in the webstatus.dev feature set for either. Treat as progressive enhancement behind feature detection.
7. **NVIDIA's current per-generation NVENC capability rows.** My automated extraction of the GPU support matrix produced values that contradict Parsec's documented Pascal-and-newer requirement for 4:4:4 HEVC encode. The matrix needs a manual read.
8. ~~**Exact Chrome jitter-buffer floor.**~~ **RESOLVED in Part 3B** by reading `timing.cc` / `jitter_estimator.cc`: `TargetDelay = max(min_playout_delay, jitter_delay + p95_decode + render_delay)`, `kDefaultRenderDelay = 10 ms`, `jitter_delay ≥ 1 ms + 10 ms OS jitter` ⇒ **≈21 ms + p95 decode ≈ 26–36 ms floor on an ideal LAN**, draining at only 100 ms/s. ⚠ But the *measured* figure is contested: Transitive Robotics' breakdown says ~10 ms, a discuss-webrtc field report says 80 ms, a Medium post says 22–27 ms. These are probably measuring different subsets of the chain (some `getStats()` fields exclude render delay and decode time). **Measure it in your own harness with `jitterBufferDelay / jitterBufferEmittedCount` vs `jitterBufferMinimumDelay` before designing around any published number.**
9. **Publication dates for most Parsec blog posts.** parsec.app/blog and the Medium mirrors carry no visible date. I have dated them by internal evidence (Chrome 70 / Project Stream ⇒ late 2018; "as of 2018"; GTX 1070-era hardware). The **support** articles all carry explicit "Updated" dates and are cited with them.

### Where sources conflict
- **4:4:4 decode path:** advanced-config page (Nov 2025) says CPU decode; hardware-compat page (May 2026) says hardware decode on Turing+/Intel 11th-gen+. See Part 1.3.
- **Codec on the marketing pages:** parsec.app/technology says *"We support the h.264 codec"*; the support Overview (July 2026) says *"We support the H.265 codec"*. The support page is newer and matches the config surface.
- **VSync guidance:** the advanced-config page says *"VSync increases latency"*; the troubleshooting page says *"on Parsec it can noticeably improve the delivery of frames in other big ways."* Both are true — it trades latency for pacing stability. **[I] The real lesson is that frame *pacing* and frame *latency* are separate goals and you must choose per use case.**
- **"Hardware decoding in the web client":** the support page says the web client has none; the shipped bundle sets `hardwareAcceleration: "prefer-hardware"`. The bundle wins.
- **Published hardware-encoder latency:** Parsec's fleet telemetry says NVENC median 5.8 ms at 60 fps; the 2025 arXiv OBS→SRS→player study reports 6–7 *frames* at 4K60. These measure different things (see Part 1.2 caveat) and should never be quoted side by side.

### Added by the two parallel streams (their own "could not verify" lists, condensed)

**From the peer-systems stream:**
- **Steam Remote Play**: codec, capture method, encoder settings, any latency figure, and whether a browser client exists at all — Valve's pages are JS-rendered and unreadable. Treat any Steam codec claim as unverified.
- **Xbox Cloud Gaming**: any measured latency or bitrate. Transport (WebRTC) and codec (H.264 Main preferred) are solid from the reverse-engineered `unknownskl/xbox-xcloud-player` client.
- **GeForce NOW**: the "sub-30 ms click-to-pixel", "Cloud G-SYNC", Reflex-on-GFN and CQS-4:4:4 claims are **Wikipedia-sourced (secondary)**; the corresponding NVIDIA pages could not be found.
- **Stadia "negative latency"**: no primary source found. **Do not cite it.**
- **Amazon DCV QUIC**: no AWS-published latency measurement exists — the docs say only *"might improve performance."* (But one hard fact did land: ***"The web browser client doesn't support the QUIC (UDP) transport protocol"*** — DCV's browser client is WebSocket/TCP only.)
- **Jump Desktop Fluid**: everything except *"Fluid 2.0 protocol"* and *"4:4:4 10 bit color"*. Their support site 403/404s.
- **No published glass-to-glass number exists** for Selkies, RustDesk, or Chrome Remote Desktop.
- **JetKVM**: no *independent* third-party measurement; all their figures are vendor self-instrumentation. (The 98 ms / 85 ms figures I cite in Part 6.7 are from a third-party review, WarpKVM, July 2026 — a different and better-sourced data point.)

**From the browser-transport stream:**
- **Safari specifics** — webkit.org and bugs.webkit.org were unreachable. The exact Safari version that shipped HEVC in WebRTC is unverified (only Chrome's Intent to Ship asserting *"Safari already shipped"*), as is Safari's `isConfigSupported` behaviour for `hvc1.*`.
- **crbug.com/436302044** (the macOS WebCodecs H.264 static-desktop bug, §5.3f) — issues.chromium.org requires sign-in; current status unknown. **This is the risk I would most want closed before committing to the design.**
- **`desynchronized` measured saving** — no published number exists anywhere.
- **`SendInput` latency cost** — not documented by Microsoft; no primary measurement found. Treat as sub-millisecond but unverified. Also: the 0–65535 absolute-coordinate normalisation is documented on the `MOUSEINPUT` page, not the `SendInput` page — verify before implementing.
- **Version conflicts flagged and resolved**: rVFC is **Chrome 83 / Firefox 132 / Safari 15.4** (raw BCD + web.dev, not the 123/126/17.4 a summary claimed). `jitterBufferTarget` is **M124** (chromestatus + BCD), not M123 (Intent to Ship).
- **Digital Foundry / Ars Technica cloud-gaming latency figures** (Stadia 166 ms at GDC 2019, xCloud 67 ms, Stadia 87 ms in-browser Jan 2022) are second-hand from search summaries — indicative, not citable.
- Both streams **exhausted the 200-call WebSearch budget** partway through and finished on direct URL fetches. A follow-up pass with search available would most likely close the Steam, Jump Desktop, and Safari gaps.

### Things I deliberately did not research
- macOS/Linux **host** capture paths (ScreenCaptureKit, PipeWire) — Swoop's host is Windows.
- Audio pipeline design beyond Parsec's Opus/PCM and buffer settings.
- Pricing, licensing and patent/royalty exposure for HEVC. **[I] Flagging it as a real question for a commercial product: HEVC carries patent-pool licensing obligations that H.264 and AV1 do not, and shipping an HEVC encoder in a Windows installer is a different legal posture from using the OS decoder.** Worth a separate look before HEVC becomes the default.


---

## PART 8 — SOURCE INDEX (my own research stream; the parallel streams list theirs inline)

All fetched **2026-09-17**. "Updated" dates are the ones the page itself displays.

### Parsec — primary, code and shipped artefacts
| Source | Date | What it establishes |
|---|---|---|
| https://web.parsec.app/ (`index.html`, `lib/matoya.js`, `lib/weblib.js`, `lib/parsec.js`) | live bundle, fetched 2026-09-17 | The entire Part 1C teardown: WASM64 + WebGL2 gate, 3 pre-negotiated data channels (control/video/audio, ids 0/1/2), STUN-only ICE, `VideoDecoder` + `EncodedVideoChunk` with `avc1.42001e` / `prefer-hardware` / `optimizeForLatency`, `drawImage` inside rAF, input handling, `parsec_login` cookie |
| HTTP response headers on https://web.parsec.app/ | fetched 2026-09-17 | `Cross-Origin-Embedder-Policy: require-corp`, `Cross-Origin-Opener-Policy: same-origin` |
| `sdk/parsec.h`, Parsec SDK (mirror: https://github.com/MalfoyJW/parsec-sdk; upstream `parsec-cloud/parsec-sdk` returns 404) | SDK v1.0 | `ParsecProtocol{BUD, SCTP}`, `ParsecContainer{PARSEC, MP4}`, `ParsecHostConfig` (`encoderFPS`, `encoderMaxBitrate` *"split between guests"*, `encoderH265`, `maxGuests` 20), `ParsecPermissions{gamepad,keyboard,mouse}`, `ParsecMetrics{encode,decode,network}`, `ParsecColorFormat` |
| https://github.com/matoya/libmatoya (redirects to snowcone-ltd) | MIT, created 2020-03-01, last push 2025-07-10, 766 stars | The framework the web client runs on |
| https://github.com/nomi-san/parsec-vdd | — | Community reimplementation of the Parsec Virtual Display Driver |

### Parsec — support documentation (dated)
| URL | Displayed date |
|---|---|
| https://support.parsec.app/hc/en-us/articles/32361354307348-Overview | **Updated July 07, 2026** |
| https://support.parsec.app/hc/en-us/articles/32361410290324-Components-and-Connection-Sequence | **Updated July 07, 2026** |
| https://support.parsec.app/hc/en-us/articles/32381460716180-Parsec-Connectivity-Requirements | **Updated July 08, 2026** |
| https://support.parsec.app/hc/en-us/articles/32381650129300-Use-the-Web-App-browser | **Updated July 07, 2026** |
| https://support.parsec.app/hc/en-us/articles/32381785123860-Improve-Stream-Quality-and-Color-Accuracy | **Updated July 07, 2026** |
| https://support.parsec.app/hc/en-us/articles/32381733729044-Multiple-Monitors-and-Virtual-Displays | **Updated July 07, 2026** |
| https://support.parsec.app/hc/en-us/articles/32381568346644-Hardware-and-Software-Compatibility | **Updated May 11, 2026** |
| https://support.parsec.app/hc/en-us/articles/32381443626516-All-Advanced-Configuration-Options | **Updated November 06, 2025** |
| https://support.parsec.app/hc/en-us/articles/32361381211284-Privacy-Mode | **July 30, 2025** |
| https://support.parsec.app/hc/en-us/articles/32381747079572-Hosting-and-Permissions | **April 22, 2025** |
| https://support.parsec.app/hc/en-us/articles/32381397579284-Configure-Parsec-Relay-Server-Legacy | **April 22, 2025** |
| https://support.parsec.app/hc/en-us/articles/32381603663636-Stream-Overlay-Stats-and-Logging | **March 17, 2025** |
| https://support.parsec.app/hc/en-us/articles/32381352822804-Troubleshooting-Lag-Latency-and-Quality-Issues | (Zendesk-dated; fetched 2026-09-17) |
*(Note: `support.parsec.app` 403s generic fetchers; all of these required a browser User-Agent.)*

### Parsec — engineering blog (undated on page; dated by internal evidence)
| URL | Est. date | Key figures |
|---|---|---|
| https://parsec.app/blog/description-of-parsec-technology-b2738dcc3842 | ~2016 | Desktop Duplication API; zero-copy; GPU pixel-shader color convert; *"encode/decode latencies lower than 10 ms"*; *"network latencies below 20 ms … near-native"* |
| https://parsec.app/blog/a-networking-protocol-built-for-the-lowest-latency-interactive-game-streaming-1fd5a03a6007 | ~2018–19 | BUD = UDP + DTLS 1.2; TCP-like reliability; custom CC; *"no buffers of any kind on video"* |
| https://parsec.app/blog/game-streaming-tech-in-the-browser-with-parsec-5b70d0f359bc | late 2018 (Chrome 70 / Project Stream) | `RTCDataChannels`; MSE "low delay" push model; Chrome-only |
| https://parsec.app/blog/nvidia-nvenc-outperforms-amd-vce-on-h-264-encoding-latency-in-parsec-co-op-sessions-713b9e1e048a | ~2018 | **NVENC 5.8 ms**, **VCE 15.06 ms**, QSV ≈11 ms medians, 60 fps, >250k sessions |
| https://parsec.app/blog/new-nvidia-gpus-outperform-new-amd-cards-on-h-264-compression-latency-d32784464b94 | ~2018 | ">3x" NVIDIA vs RX 480/570/580 (no absolute numbers) |
| https://parsec.app/blog/parsec-game-streaming-total-latency-at-240-frames-per-second-c0818cc0daa5 | ~2018 | **4–8 ms** total pipeline at 240 fps LAN; "two frames behind" with VSync |
| https://parsec.app/blog/testing-game-streaming-input-latency-on-parsec-with-diy-instructions-49ae838f45a7 | ~2018 | 16 ms direct vs **23 ms** via Parsec ⇒ **+7 ms**, gigabit LAN, 240 Hz |
| https://parsec.app/blog/an-introduction-to-video-compression-c5061a5d075e | ~2018 | *"HEVC … increases latency in a lot of consumer hardware"* |
| https://parsec.app/technology | undated | 7 ms LAN; 97% NAT traversal; 95% co-play |

### Platform / standards / vendor
| Source | Date | Used for |
|---|---|---|
| https://learn.microsoft.com/en-us/windows/win32/direct3ddxgi/desktop-dup-api | ms.date 2018-05-31, updated 2025-04-15 | DDA behaviour: B8G8R8A8 always, dirty/move rects, update coalescing, separate cursor, rotation |
| https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-sendinput | ms.date 2018-12-05, updated 2025-07-01 | UIPI restriction, silent failure, serial insertion, keyboard state not reset |
| https://docs.nvidia.com/video-technologies/video-codec-sdk/13.0/nvenc-video-encoder-api-prog-guide/index.html | SDK 13.0 | Tuning infos, P1–P7, CBR, `lowDelayKeyFrameScale`, intra refresh, `NvEncInvalidateRefFrames`, `enableLTR`, split-frame encoding, YUV444 |
| https://developer.nvidia.com/video-encode-and-decode-gpu-support-matrix-new | fetched 2026-09-17 | NVENC concurrent-session limits (GeForce capped / professional unrestricted) — **codec rows unverified, see Part 7** |
| https://chromestatus.com/api/v0/features (queried live) | 2026-09-17 | HEVC-in-WebRTC M136, HEVC hw decode M107, HEVC in WebCodecs M130, `jitterBufferTarget` M124, rVFC M83, WebRTC SVC M111, AV1 decode M70 |
| https://api.webstatus.dev/v1/features (queried live) | 2026-09-17 | Cross-browser matrix: **WebCodecs Safari 26 @2025-09-15**, WebTransport Safari 26.4 @2026-03-24, rVFC Baseline 2024-10-29, desynchronized canvas (no Firefox), **Memory64 has no Safari support** |
| https://www.w3.org/TR/webcodecs-avc-codec-registration/ | W3C Group Note Draft, **8 June 2026** | `avc1.`/`avc3.`; description present ⇒ AVCC, absent ⇒ Annex B |
| https://www.w3.org/TR/webcodecs-hevc-codec-registration/ | W3C Group Note Draft, **8 June 2026** | `hev1.`/`hvc1.`; same description rule; Annex B recommended for live |
| https://developer.mozilla.org/en-US/docs/Web/API/VideoDecoder/configure | MDN, fetched 2026-09-17 | `optimizeForLatency` semantics; `hardwareAcceleration` values |
| https://developer.mozilla.org/en-US/docs/Web/API/HTMLVideoElement/requestVideoFrameCallback | MDN; Baseline since **Oct 2024** | rVFC metadata fields |
| https://w3c.github.io/webrtc-extensions/#dom-rtcrtpreceiver-jitterbuffertarget | published standard | `jitterBufferTarget` spec anchor |

### Third-party measurements
| Source | Date | Figures |
|---|---|---|
| https://warpkvm.com/blog/jetkvm-review | **July 17, 2026** | JetKVM ≈**98 ms** click-to-photon wired LAN, ≈**85 ms** device-side; RockChip **RV1106G3** (Cortex-A7), Toshiba **TC358743** HDMI→CSI, 1080p60, H.264/H.265, WebRTC |
| https://arxiv.org/html/2511.18688v1 — Arunruangsirilert & Katto, *Evaluation of GPU Video Encoder for Low-Latency Real-Time 4K UHD Encoding* | **November 2025** | 4K60: NVIDIA 6–7 frames, Intel 5–8 (ULL), AMD 6–9, software 41–90+; **methodology is OBS → SRS WebRTC → player, photographed** |
| https://blurbusters.com/understanding-display-scanout-lag-with-high-speed-video/ | (403s to fetchers; figures via search summary) | 60 Hz scanout: 0 ms top, 8.3 ms centre, 16.7 ms bottom — **secondary citation, verify before quoting** |
