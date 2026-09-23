# Swoop — WebRTC host transport bake-off (verification pass)

**Date of research:** 2026-09-17. Every claim below is tagged `[verified: source, date]` or `[inference]`.
**Scope:** host-side WebRTC sender in Rust, Windows x64, running as SYSTEM, pushing pre-encoded
H.265/H.264 Annex-B access units to 1..N browser peers.

> **Headline:** the earlier research pass is substantially out of date. Both leading Rust stacks
> (str0m, webrtc-rs) grew H.265 packetizers and GCC congestion control during 2026. The real
> discriminators are now (i) *which* GCC port, (ii) TURN/TLS plumbing, (iii) FEC, and
> (iv) the fact that **Edge and Firefox do not receive H.265 over WebRTC at all**, which makes
> H.264 the primary path rather than the fallback.

---

## 0. Browser reality check (do this before anything else)

| Browser | H.265 receive over WebRTC | Evidence |
| --- | --- | --- |
| Chrome (Win/macOS/Android) | **Yes**, default on from **M136**, hardware-decode gated | `WebRtcAllowH265Receive`/`Send` flipped on by default in M136 [verified: chromestatus feature 5153479456456704 + blink-dev Intent to Ship; M136 stable 2025-04-29] |
| Edge | **No** — never enabled, neither send nor receive | Microsoft moderator: *"At this time, Edge does not support publishing (sending) H.265 over WebRTC… There is currently no publicly available roadmap"*; Edge 136 release notes listed it in error and were corrected ~Dec 2025 [verified: Microsoft Q&A learn.microsoft.com/answers/questions/5875799, answered 2026-05-14, updated 2026-09-10] |
| Safari 18+ | **Yes**, default on | [verified: chris.hiszpanski.name/posts/is-webrtc-hevc-supported, 2024-07-07, updated for M136] |
| Firefox | **No**, and Mozilla has signalled it will not | [verified: mozilla/standards-positions issue #1188] |

**Consequence for Swoop:** H.264 is not a fallback, it is the *default* for a meaningful share of
the fleet (all Edge, all Firefox, Chrome on machines without HEVC hardware decode). Any stack
chosen must do both well, and the SDP layer must negotiate per-peer, not per-session. This also
means the "one encoded stream fanned out to N peers" requirement is really "one H.265 stream to
the HEVC-capable peers **and** one H.264 stream to the rest" — budget for two concurrent GPU
encodes, not one. [inference, but forced by the table above]

Chrome's H.265 offer as seen in the wild (Chrome 144.0.7559.133, macOS arm64, Feb 2026):

```
a=fmtp:49 level-id=180;profile-id=1;tier-flag=0;tx-mode=SRST
```

[verified: str0m issue #860, opened 2026-02-08, closed 2026-03-04]

---

## 1. Decision matrix

Columns are the ten requirements from the brief. `Y` = supported and evidenced, `P` = partial /
needs app code, `N` = absent, `?` = unverified.

| # | Requirement | **str0m 0.23.1** | **webrtc-rs `webrtc` 0.20.5 / `rtc`** | **libwebrtc (prebuilt)** | **libdatachannel** | **GStreamer webrtcsink** | **Pion (via sidecar)** |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | H.265 RTP (RFC 7798) Chrome accepts + H.264 | **Y** — `packet/h265.rs` (5 203 lines: SNU/AP/FU/PACI), **caches VPS/SPS/PPS and emits them as an AP**, `H265ProfileTierLevel`, PT 102 + RTX 103, level-id 180 to match Chrome | **Y** — RFC 7798 SNU/AP/FU; issue #779 **closed 2026-03-07**; greedy AP aggregation but **no param-set cache** | **Y** (m150 fork, `rtc_use_h265=true`) | **Y** — `h265rtppacketizer` takes Annex-B directly | **Y** — `video/x-h265` in default caps | **Y** — param-set cache + AP, fixed for Chrome 2026-01-04 |
| 2 | Inject pre-encoded frames (no internal encoder) | **Y** — `Writer::write` (str0m packetizes) *or* RTP mode `StreamTx::write_rtp(RtpWrite…)` | **Y** — `TrackLocalStaticSample` / `write_rtp` | **Y** — LiveKit's merged passthrough encoder; `capture_encoded_frame()` (§4d) | Y | **Y** — native, cleanest of all | Y — `WriteSample` |
| 3 | TWCC → GCC → retarget encoder; pacer; NACK/RTX; PLI/FIR; FEC | **Y (libwebrtc GoogCC port: trendline+AIMD+loss+probe+ALR)**, leaky-bucket pacer w/ probing, NACK/RTX, PLI/FIR — **N for FEC** | **Y** — TWCC + GCC (Kalman/draft-02 shape) + pacing + NACK + intervalpli + **FlexFEC** + RFC 8888 | **Y** — the reference implementation | **N — no transport-cc at all, no BWE.** Only `nack`, `nack pli`, `ccm fir`, `goog-remb` | **Y** — `congestion-control=gcc` by default (`rtpgccbwe`) | **Y** — `pkg/gcc` + `GetTargetBitrate()`/`OnTargetBitrateChange()`, pacer, FlexFEC |
| 4 | Header exts: playout-delay, abs-send-time/transport-cc, abs-capture-time, video-timing | **Y — all four**, plus color-space, frame-marking, video-content-type, and `UnknownUri` for arbitrary extensions; settable **per packet** in RTP mode | **P** — playout-delay, abs-send-time, transport-cc, audio-level, video-orientation; **no abs-capture-time, no video-timing** | **Y** — plus `with_zero_playout_delay()` which installs `WebRTC-ForcePlayoutDelay/min_ms:0,max_ms:0/` | **P** — **playout-delay is native** (`playoutDelayId/Min/Max`, v0.24.5); abs-capture-time master-only; **no transport-cc type at all** | **P** — **no playout-delay anywhere in GStreamer** (0 hits repo-wide); write a ~50-line `GstRTPHeaderExtension` subclass | **Y** — `playoutdelayextension.go` + `abscapturetimeextension.go` |
| 5 | ICE + TURN over UDP **and TCP and TLS:443**, mDNS, ICE restart | **P** — full ICE agent, `Protocol::{Udp,Tcp,SslTcp,Tls}`, `tcptype`, relay candidates, **`ice_restart()`**; **TURN allocation and mDNS are the app's job.** Fill with `turn-client-proto` 0.7.2 + `turn-client-rustls` 0.1.1 (est. 3–6 eng-weeks) | **Y-ish** — `rtc-turn`, `rtc-mdns`, ICE-TCP active/passive, **ICE restart**; **turns:443 end-to-end unconfirmed** | **Y** — reference impl | **N ×2** — libjuice logs *"TURN transports TCP and TLS are not supported"* and drops the server; **and no ICE restart** (#545 open since 2022, PR #1568 closed unmerged 2026-05-22). libnice backend has no Windows CI | **P** — `turns://` + `?transport=tcp` fully wired to libnice (verified in `nice.c:521-546`); **but no ICE restart** — 3× `FIXME` in `gstwebrtcbin.c` | **Y (best matrix)** — udp/tcp/**tcp-alloc RFC 6062**/**tls**/mutual-TLS, mDNS, ICE restart |
| 6 | SCTP data channels, reliable + unordered/unreliable | **Y** — `sctp-proto` 0.10.4, negotiated max msg size, stream reset on close | **Y** — 689 Mbps single-conn, >5 Gbps aggregate, GSO/GRO | **Y** | **Y** (its raison d'être) | P | **Y** |
| 7 | One encoded stream → several PeerConnections | **Y** — N independent `Rtc` state machines, no locks/`Arc`/threads; packetize once, write into each | **Y** | **P** — factory is per-PeerConnectionFactory → N encoder shims; copy the Unreal fan-out pattern (§4d) | Y | **Y** — native multi-consumer | **Y** |
| 8 | Memory safety + fuzzing (runs as SYSTEM, untrusted input) | **Y (best)** — safe Rust; 12 fuzz targets; *"str0m should never panic on any user input"*; 0.23.1 was a parser-hardening release (#1029) | **Y** — safe Rust, codecov-gated CI | **N** — C++; a 114–745 MB unauditable blob in a SYSTEM process | **N** — C++ | **P** — Rust plugin over an LGPL C framework | **P** — memory-safe, but a Go runtime + GC in the media path |
| 9 | Licence OK for commercial source-available (no GPL) | **Y** — MIT OR Apache-2.0 | **Y** — MIT OR Apache-2.0 | **Y** — BSD-3 (libwebrtc) + Apache-2.0 (LiveKit) | **Y** — MPL-2.0 (but libnice is LGPL) | **P** — plugin MPL-2.0, framework **LGPL-2.1** (dynamic link + relink rights) | **Y** — MIT |
| 10 | Windows x64 build a small team maintains in GH Actions | **Y (best)** — pure-Rust `rust-crypto` or Windows-CNG `wincrypto`; **no OpenSSL, no C toolchain, no native deps** | **Y** — pure Rust; `crypto-ring` (no NASM) or `aws-lc-rs` | **P** — one `cargo build`, but forces workspace-wide `+crt-static`, release-only libwebrtc, and a 114 MB download pinned to someone else's milestone | P — CMake/C++, vcpkg | **N** — ~100 MB of GStreamer DLLs in the installer | **P** — two languages, two toolchains, a sidecar to sign and supervise |

---

## 1.5 Recommendation

### 1st choice — **str0m 0.23.1 + `turn-client-proto` / `turn-client-rustls`**

**Deciding reasons:**
1. **The congestion controller is the product.** A remote desktop is a closed loop between the
   network estimate and the GPU encoder's bitrate, and str0m is the only non-libwebrtc option whose
   BWE is a port of *libwebrtc's* GoogCC — trendline estimator, AIMD, loss controller, probe
   controller with libwebrtc's own constants, ALR detection. Everything else here is either the
   simplified 2016 draft (webrtc-rs, Pion: Kalman/arrival-group), a linear regression (KVS), or
   absent (libdatachannel).
2. **The H.265 packetizer is already Chrome-correct**, including the VPS/SPS/PPS aggregation-packet
   behaviour that Pion had to be bug-fixed into in 2026 and that webrtc-rs still relies on the
   encoder for. And there is a closed Chrome-144 interop issue to prove someone ran it.
3. **Header-extension control is per packet and includes an escape hatch.** playout-delay
   min=0/max=0 on every packet is the single highest-value latency lever (§5.1) and str0m gives it
   to us directly.
4. **Requirement 8.** Safe Rust, 12 fuzz targets, an explicit no-panic-on-untrusted-input policy,
   and a recent hardening release — in a process that runs as SYSTEM and parses packets from the
   internet. No C++ blob, no Go runtime.
5. **Requirement 10.** `wincrypto` (Windows CNG) or `rust-crypto`: no OpenSSL, no NASM, no C
   toolchain, no prebuilt download. This is the cheapest CI story of any option.

**Biggest risk: TURN.** Not that it can't be done — `turn-client-proto` 0.7.2 +
`turn-client-rustls` 0.1.1 are current, sans-IO, and `arcly-stream-webrtc` already shipped a str0m
TURN client — but that the honest estimate is **3–6 engineer-weeks plus an open-ended interop tail**
against coturn, Cloudflare TURN and real corporate middleboxes, for a feature that is invisible
until a customer's firewall eats UDP. Secondary risks: **no FEC**, **no mDNS** (so `.local`
candidates from Chrome are unusable and LAN peers fall back to srflx/relay), and **thin production
evidence** — Lookback, BitWHIP, arcly, lumyx, but no named large commercial deployment.

### 2nd choice — **LiveKit `libwebrtc` 0.3.48 with the pre-encoded passthrough**

**Deciding reasons:** the protocol behaviour is Chrome's own, by construction; H.265 negotiation,
NACK/RTX, FEC, TURN over UDP/TCP/TLS, mDNS and ICE restart are all the reference implementation;
`with_zero_playout_delay()` ships the exact `min_ms:0,max_ms:0` field trial we want; the
pre-encoded Rust API (`new_encoded` / `capture_encoded_frame` / `take_keyframe_request` /
`take_rate_control_request`) is merged, maintained and exactly the shape we need; and the build is
one `cargo build` against a 114 MB prebuilt with a first-class `x86_64-pc-windows-msvc` CI target.
This is the option that gets to "works in every browser behind every firewall" fastest.

**Biggest risk: it is a 114 MB unauditable C++ blob inside a SYSTEM service, pinned to someone
else's libwebrtc milestone.** Secondary: workspace-wide `+crt-static` constrains everything else we
link; the Rust API gives no custom `VideoEncoderFactory` and no `FrameTransformer`, so anything
LiveKit didn't anticipate means forking `webrtc-sys`; 1→N fan-out needs the Unreal-style
shared-encoder pattern built by hand (§4d), and it brings global keyframes and a
slowest-peer-wins bitrate with it; and standalone (non-SFU) use is *possible* but *undocumented*.

### Not recommended, and why

**webrtc-rs 0.20.5/0.21-rc** is a genuinely close third and would be first if BWE quality did not
dominate — it has FlexFEC, `rtc-mdns` and `rtc-turn` in-tree, which are exactly str0m's three gaps.
If the spike shows str0m's TURN integration is worse than expected, re-open this.
**Pion as a sidecar** is technically the most complete, but a second binary to install, sign,
supervise and self-update on the fleet is a real ongoing cost against Owlette's installer model.
**libdatachannel** fails requirement 3 outright (no transport-cc, no BWE, and nobody in four years
has shipped one on it) *and* requirement 5 twice (libjuice does not do TURN over TCP or TLS, and
there is no ICE restart) — reject. **GStreamer** is a stronger contingency than the earlier pass
implies: the right shape is **`webrtcbin` + the standalone MPL-2.0 `rtpgccbwe` element**, not
`webrtcsink` (which cannot drive bitrate on pre-encoded input at all), and that combination is the
only option here with GCC *and* FEC *and* TURN-over-TLS all shipping today — at the cost of an
84 MB runtime, an LGPL compliance chore, a hand-written playout-delay extension, and no ICE
restart. **KVS** is C and weak on Windows. **MoQ** has no browser-to-host direct path yet.

### The side bet worth taking in week 1

Spend one day proving or killing **encoded-frames-over-data-channel + WebCodecs** (§4f). Three
independent Parsec-class projects converged on it, MoonlightWeb reports <20 ms glass-to-glass on
a LAN with it, and it deletes the H.265 RTP packetizer, the Chrome fmtp negotiation, the
playout-delay problem *and* the Edge/Firefox H.265 gap in one move — at the cost of owning
congestion control yourself. That is a big enough prize to be worth a day before committing to RTP.

---

## 2. Verdict on claim (a) — str0m

> *Claimed: "str0m has no H.265 and no TURN."*

**Half refuted, half confirmed-with-a-cheap-fix.**

### H.265 — REFUTED, decisively

- `src/packet/h265.rs` is **5 203 lines** implementing RFC 7798 in full: single-NAL-unit packets,
  Aggregation Packets (type 48), Fragmentation Units (type 49) and PACI (type 50), with IRAP
  keyframe detection over BLA 16–18 / IDR 19–20 / CRA 21.
  [verified: raw.githubusercontent.com/algesten/str0m/main/src/packet/h265.rs, HEAD 2026-09-15]
- Landed in **0.16.0** ("H265 Packetizer/Depacketizer"); hardened through 0.16.1 (PACI short-payload
  panic), 0.16.2 (`is_irap()` keyframe detection), 0.17.0 (RTP-level keyframe detection),
  0.19.0 (profile structs exposed). [verified: CHANGELOG.md, HEAD 2026-09-15]
- `RtcConfig::enable_h265()` exists and **H.265 is enabled by default**; only H.266/VVC is opt-in
  ("H266/VVC off by default: no browser supports it"). Default PT 102, RTX PT 103.
  [verified: src/format/codec_config.rs, HEAD]
- fmtp round-trips `profile-id`, `tier-flag`, `level-id` and `sprop-max-don-diff` (RFC 7798 §7.1).
  [verified: src/format/format_params.rs tests, HEAD]
- **Chrome interop has been exercised for real.** Issue #860 ("H265 SDP negotiation: level-id=180
  from latest Chrome", opened 2026-02-08, closed 2026-03-04) reports Chrome 144 offering
  `level-id=180;profile-id=1;tier-flag=0;tx-mode=SRST` against str0m's hardcoded 156; the default
  is now 180 with the comment *"Chromium H265Level enum definition (kLevel6 = 180)"*.
  [verified: github.com/algesten/str0m/issues/860 + src/format/codec_config.rs]
- Caveat: `Codec::H265` is still `#[doc(hidden)]` with a stale `// TODO show this when we support
  h265` comment, and `enable_h265()`'s doc says *"H265 is still considered an experimental/hidden
  codec in parts of the public API"*. The code is real; the docs lag. [verified: src/format/codec.rs]
- str0m also ships **H.266/VVC** (added 0.21.0, PR #971) — irrelevant today, but it shows the
  packetization layer is actively generalised. [verified: CHANGELOG]

### TURN — CONFIRMED, but it is a bounded, ~1-week integration, not a blocker

str0m is sans-IO by design and says so explicitly:

> *"TURN is a way of obtaining IP addresses that can be used as fallback… We consider TURN similar
> to enumerating local network interfaces – it's a way of obtaining sockets. All discovered
> candidates, be they local (NIC) or remote sockets (TURN), are added to str0m and str0m will
> perform the task of ICE agent… while the actual task of sending the network traffic is left to
> the user."* [verified: README.md, HEAD 2026-09-15]

But the *protocol model* is already there:

- `str0m_proto::Protocol` = `{ Udp, Tcp, SslTcp, Tls }` — `Tls` is documented as **"only used via
  relay"**, i.e. str0m explicitly models TURN-over-TLS relay candidates.
  [verified: crates/proto/src/net.rs, HEAD]
- `TcpType` (RFC 6544 §4.5 active/passive/so), relay candidates (`add_relay_candidate(relay_addr,
  mapped_addr)`), candidate-pair priority rules that specifically reason about relay-vs-direct and
  IPv4-relay-vs-IPv6, and `Agent::ice_restart(creds, keep_local_candidates)`.
  [verified: crates/is/src/{candidate.rs,agent.rs,lib.rs}, HEAD]
- The missing piece is an *allocation client*. It exists off the shelf and is maintained:

  | crate | version | last publish | note |
  | --- | --- | --- | --- |
  | `turn-client-proto` | 0.7.2 | 2026-08-05 | sans-IO TURN client; RFC 5766 + 6062 (TCP allocations) + 6156 (IPv6) + 8656 |
  | `turn-client-rustls` | 0.1.1 | 2026-08-05 | **TURN over TLS/TCP** |
  | `turn-client-dimpl` | 0.2.0 | 2026-08-05 | TURN over DTLS/UDP — and `dimpl` is *the same DTLS crate str0m uses* |
  | `stun-proto` | 2.0.2 | 2026-07-31 | shared STUN layer |

  [verified: crates.io API, fetched 2026-09-17]

  The `turn-client-dimpl` / str0m `dimpl` overlap is not a coincidence — it means one DTLS
  implementation, one audit surface. [inference]

- **Precedent exists**: `arcly-stream-webrtc` 0.3.1 (published 2026-09-16, MIT) is a WHIP/WHEP
  transport *built on str0m in RTP mode* that ships *"a built-in TURN client
  (Allocate/CreatePermission/Refresh; Send/Data relay)"*. So somebody has already done this
  integration in public. (It has no BWE — *"no bandwidth-estimation / REMB egress adaptation"* —
  so it is a template for the TURN half only.) [verified: docs.rs/arcly-stream-webrtc/0.3.1]

### The parts of claim (a) the brief asked about that were never in dispute — and are all strong

**BWE.** This is str0m's standout feature and the earlier pass missed it entirely. `src/bwe/mod.rs`
opens:

> *"Google Congestion Control (GoogCC) Bandwidth Estimation based on TWCC feedback. This
> implementation is ported from libWebRTC's GoogCC and goes beyond the simplified IETF draft
> (draft-ietf-rmcat-gcc-02) to include WebRTC's production features: delay-based control (trendline
> estimator with AIMD rate control); loss-based control (with inherent loss rate estimation); probe
> controller with state machine and multi-stage probing strategy; ALR (Application Limited Region)
> detection and periodic probing; link capacity estimation from ALR probes. The probe controller in
> particular closely matches WebRTC's ProbeController behavior and default constants."*

Modules present: `acked_bitrate_estimator`, `alr_detector/`, `delay/{arrival_group, trendline,
rate_control, control}`, `link_capacity_estimator`, `loss_controller`, `probe/`, `smoother`.
[verified: src/bwe/, HEAD 2026-09-15]

This matters more than anything else in the matrix: it is a port of *the same algorithm Chrome
runs*, not of the simplified draft. **`Event::EgressBitrateEstimate(BweKind)`** is the hook we
feed straight into NVENC/AMF bitrate retargeting. [verified: src/lib.rs:1014]

**Pacer.** `LeakyBucketPacer` with probe-cluster support (`start_probe(ProbeClusterConfig)`,
`check_probe_complete`), queue priorities, padding/media debt accounting — i.e. a real
libwebrtc-shaped `PacedSender`, plus a `NullPacer` for when you want none.
[verified: src/pacer/, HEAD]

**NACK/RTX.** RTX SSRC pairs (`new_ssrc_pair`), `StreamTx::set_rtx_cache(...)`, configurable RTX
ratio cap, `nackable(bool)` per packet in RTP mode. [verified: src/streams/send.rs, CHANGELOG 0.6.3]

**PLI/FIR.** `Event::KeyframeRequest(KeyframeRequest)` with `KeyframeRequestKind`; outbound
`DirectApi::send_pli_feedback(sender_ssrc, media_ssrc)` added in 0.23.0.
[verified: src/lib.rs:1021, src/change/direct.rs:431]

**FEC — genuinely absent.** There is RFC 2198 RED for *audio* (added #982, in the unreleased
section) and no ULPFEC or FlexFEC anywhere. [verified: CHANGELOG + src/packet/ has no fec module]
For a screen-content stream at low latency this is a real but survivable gap: RTX+NACK covers a
1-RTT-tolerant loss, and for the sub-RTT case you would otherwise be spending an IDR anyway.
[inference]

**Header extensions.** `Extension` covers AbsoluteSendTime, **AbsoluteCaptureTime**,
TransportSequenceNumber, **PlayoutDelay**, **VideoTiming**, VideoContentType, ColorSpace,
FrameMarking, RtpMid, RtpStreamId, RepairedRtpStreamId, TransmissionTimeOffset, AudioLevel,
VideoOrientation — **plus `Extension::UnknownUri(String, Arc<dyn …Serializer>)`**, an escape hatch
for any extension str0m doesn't know (e.g. Dependency Descriptor). Two-byte header form supported.
In RTP mode `RtpWrite::ext_vals(ExtensionValues)` sets them **per packet**.
[verified: src/rtp/ext.rs, src/streams/send.rs:262, HEAD]

This is the single most important row for Swoop after BWE: we need `playout-delay` min=0/max=0 on
every video packet, and str0m gives it to us at the exact granularity required.

**ICE.** Full ICE (not ice-lite) with `set_ice_lite(bool)` if you want the server mode; trickle via
`add_local_candidate`/`add_remote_candidate` at any time; `ice_restart`; ICE role-conflict
resolution (#950); candidate-pair RTT in stats (#962); `tcptype` handling (0.15.0); candidate
invalidation matched on protocol (#1035, 2026-09-09). **mDNS `.local` resolution is the app's job**
— Chrome sends `.local` host candidates, so without an mDNS resolver you fall back to srflx/relay
for LAN peers, which on a LAN is a measurable latency regression. [verified: crates/is/, README]

**Data channels.** `sctp-proto` 0.10.4, `ChannelConfig` with reliability parameters, negotiated max
message size (#852), stream reset + safe stream-ID reuse on close (#1010), `buffered_amount` +
`ChannelBufferedAmountLow`. Reliable and unordered/unreliable both configurable.
[verified: CHANGELOG, src/channel.rs]

**Crypto / Windows build.** Six pluggable backends. Relevant ones: `rust-crypto` (pure Rust,
dimpl+RustCrypto) and `wincrypto` (dimpl + **Windows CNG**). The unreleased branch *removes
SChannel entirely* in favour of dimpl+CNG (#1038). **No OpenSSL is required on Windows**, which
removes the usual CI landmine. Default is `aws-lc-rs` (needs NASM on Windows, but ships
`prebuilt-nasm`). [verified: README "Crypto backends", Cargo.toml, CHANGELOG HEAD]

**Maturity signals.** MSRV 1.85, edition 2024. 2.17 M downloads. Five releases in ~4 months
(0.20.0 2026-05-29 → 0.23.1 2026-08-21) and commits on 2026-09-15. Contributions arriving from
Microsoft (`rbadraddinli@microsoft.com`, PR #1040). A `netem` crate in-tree for network-emulation
testing. [verified: crates.io + GitHub API, 2026-09-17]

**Production users.** Weakest evidence in the whole report. Confirmed: **Lookback** (the origin,
server-side SFU — *"we use str0m for a specific use case: str0m as a server SFU"*), **BitWHIP**
(CLI WebRTC agent, cited in the README as the real-world example), **arcly-stream** (WHIP/WHEP
transport), **lumyx** (open-source Rust SFU, alpha, *"media handling sits on str0m — no callbacks,
no C++ dependency, no GC pause in the middle of a video frame"*). There is no named large-scale
commercial deployment in public. [verified: README 2026-09-15 + the crates/repos named; the absence
is itself the finding]

---

## 3. Verdict on claim (b) — webrtc-rs

> *Claimed: "webrtc-rs is mid-rewrite (v0.17 frozen, sans-IO `rtc` v0.20) and its H.265 packetizer
> has an open bug."*

**Was true in early 2026. Refuted as of 2026-09.** The rewrite **landed**.

- **v0.20.0 shipped stable 2026-07-31** — *"the first stable release of the new Sans-I/O,
  runtime-agnostic architecture… supersedes the Tokio-coupled v0.17.x line, which is now in
  bug-fix-only maintenance… v0.20.x is the current line and the recommended choice for all new
  projects."* [verified: webrtc.rs/blog/2026/07/31/announcing-webrtc-v0.20.0.html]
- Current: **v0.20.5** (2026-09-04) with **v0.21.0-rc.2** (2026-09-04) in flight; `rtc` repo pushed
  2026-09-15. [verified: GitHub releases API, 2026-09-17]
- **The H.265 bug is closed.** Issue #779 ("fix and verify H265 packetizer/depacketizer issue in
  simulcast example and play-from-disk-h26x/save-to-disk-h26x examples") — opened 2026-03-01,
  **closed completed 2026-03-07**. `rtc-rtp/src/codec/h265/` implements RFC 7798 single-NAL /
  aggregation / fragmentation with a `HevcPayloader` that picks by MTU, plus `h265_test.rs`.
  **PACI (type 50) is not implemented** — only the three shapes; that is fine for sending (nobody
  needs PACI outbound) but means a receive path can't parse it. [verified: GitHub issue #779 +
  rtc-rtp/src/codec/h265/mod.rs, HEAD 2026-09-15]
- **TWCC/GCC: present and substantial.** `rtc-interceptor/src/` contains `twcc/`, `gcc/`, `cc/`,
  `pacing/`, `nack/`, `intervalpli/`, `report/`, `rfc8888/` (RTCP congestion control feedback),
  `rtpfb/`, `jitterbuffer/` and **`flexfec/`** — webrtc-rs has FEC where str0m does not.
  [verified: GitHub contents API, HEAD]
  **But the GCC is a port of Pion's, not of libwebrtc's.** The module header says: *"Google
  Congestion Control, ported as synchronous functions… Upstream fans acknowledgements into two
  goroutines over two channels"*, and the pipeline is
  `PacketReports → ArrivalGroupAccumulator → Kalman → overuse detector → rate control`.
  A Kalman-filter arrival-group estimator is `draft-ietf-rmcat-gcc-02`; Chrome itself moved to the
  trendline estimator years ago. [verified: rtc-interceptor/src/gcc/mod.rs, HEAD]
  **This is the decisive technical difference between str0m and webrtc-rs for Swoop.**
  It *is* public API — `rtc-interceptor/src/lib.rs` re-exports `gcc::estimator::Gcc`,
  `gcc::kalman::Kalman`, `gcc::rate_control::*`, `gcc::loss::*`, `gcc::overuse::OveruseDetector`,
  `cc::estimator::{BandwidthEstimator, ConstantBitrate, EstimatorStats}` and
  `flexfec::draft03::{FlexFec03Encoder, FlexFec03Decoder, FlexFec03SendInterceptor, …}`.
  (A parallel research thread reported "no bandwidth estimator in webrtc-rs" — **that is wrong**;
  the direct source read above supersedes it.)
  [verified: raw.githubusercontent.com/webrtc-rs/rtc/master/rtc-interceptor/src/lib.rs:228-278, 2026-09-17]
- **TURN**: `rtc-turn` crate in-tree (client: allocation, permission, relay, binding, transaction).
  `rtc-ice/src/url` parses `stun`/`stuns`/`turn`/`turns` schemes and `?transport=udp|tcp`. The
  v0.20.0 announcement lists *"TURN relays including TCP/TLS variants"* and *"ICE TCP
  active/passive support in the new driver"*. **However**, `rtc-turn`'s own doc example only shows
  `TransportProtocol::UDP`, and `rtc-turn/Cargo.toml` has no TLS dependency — TLS must therefore be
  supplied by the async driver above it. **I could not verify end-to-end TURN-over-TLS:443 from the
  source.** Treat as `?` until spiked. [verified for parse + crate presence: rtc-ice/src/url/mod.rs,
  rtc-turn/, HEAD; announcement claim: blog 2026-07-31; **unverified**: working turns:443]
- **`rtc-mdns` exists** — webrtc-rs solves the `.local` candidate problem in-tree, str0m does not.
  [verified: GitHub contents, HEAD]
- **Header extensions are thinner**: `rtc-rtp/src/extension/` has `abs_send_time_extension`,
  `audio_level_extension`, `playout_delay_extension`, `transport_cc_extension`,
  `video_orientation_extension` — **no abs-capture-time, no video-timing, no color-space, no
  generic unknown-URI escape hatch.** Playout-delay is there, which is the one that matters most.
  [verified: GitHub contents, HEAD]
- Data channels are the strong suit: 689 Mbps single-connection, >5 Gbps aggregate, UDP GSO/GRO
  batching, bounded reactor pools, opt-in send back-pressure.
  [verified: blog 2026-07-31]
- Acknowledged gaps from the maintainers themselves: *"no stream-based APIs, no comprehensive
  browser interop testing (Edge untested), no embassy runtime, no connection-setup-time metrics."*
  **"No comprehensive browser interop testing" is a direct hit on our highest-risk requirement.**
  [verified: blog 2026-07-31]
- Licence MIT OR Apache-2.0. Sponsors: Recall.ai (gold), Stream + Channel.io (silver).
  [verified: rtc README, HEAD]

**Independent corroboration — someone is building our exact product on it.** `1ax/rcdesk`
("Browser-based remote desktop: Rust host for macOS/Windows, WebRTC, works in Safari and Chrome",
ARCHITECTURE.md dated **2026-09-14**) picked `webrtc` 0.20.5 over str0m 0.23.1, reasoning:
*"Full stack (ICE/DTLS/SRTP/SCTP), NACK/TWCC interceptors, API familiar from pion. Future fork:
`str0m` (sans-IO, built-in BWE) **if we hit a wall on bitrate control**."* They ship H.264 only
(openh264 software fallback + VideoToolbox/Media Foundation MFT hardware), `scap` for capture,
coturn for TURN. [verified: github.com/1ax/rcdesk ARCHITECTURE.md + Cargo.toml, 2026-09-14]

That footnote — *"if we hit a wall on bitrate control"* — is precisely the wall Swoop will hit,
because a remote desktop lives or dies on the encoder-retarget loop.

---

## 4. Verdicts on claims (c)–(f)

### (c) libdatachannel — "no TWCC/BWE, and libjuice does TURN over UDP only"

> **CONFIRMED on both counts. This is the one claim from the earlier pass that survives intact,
> and it disqualifies the library for Swoop.**

- **No transport-cc, anywhere.** `src/description.cpp` advertises exactly `nack`, `nack pli`,
  `ccm fir`, `goog-remb`. There is no `transport-cc` string and no TWCC header-extension type in
  `rtp.hpp`. No bandwidth estimator, no GCC. REMB is what Chrome falls back to when transport-cc is
  absent, and Chrome deprecates REMB whenever transport-cc is available — so we would be running
  the *worse* of Chrome's two feedback mechanisms.
  OBS Studio's own WebRTC roadmap (discussion #10372, opened 2024-03-14, active into Jan 2025)
  still lists bandwidth estimation as "optional / needs investigation"; pacing and simulcast
  landed, BWE did not. [verified: libdatachannel source + obsproject discussion #10372]
- **libjuice, the default ICE backend, is UDP-only.** Its README: *"Only UDP is supported as
  transport protocol and other protocols are ignored."* To get TURN over TCP/TLS you must build
  against **libnice**, which is **LGPL-2.1** and drags in GLib — a materially worse Windows
  dependency story. [verified: libjuice README]
- **ICE restart is also absent.** Issue #545 open since 2022-01-25; PR #1568 ("Expose ICE restart
  through the C API") was closed unmerged by its own author on 2026-05-22 because libjuice's
  `agent_set_local_ice_attributes()` returns `JUICE_ERR_FAILED` once gathering has started. The
  maintainer agreed libjuice must implement it first. **Requirement 5 fails twice over.**
- **Credit where due — it *does* ship playout-delay natively.**
  `RtpPacketizationConfig::{playoutDelayId, playoutDelayMin, playoutDelayMax}` (PR #1152,
  2024-04-01, present in v0.24.5). That is better than GStreamer, which has none. (My earlier
  draft said "none found" — corrected.)
- `h265rtppacketizer.hpp` (contributed by Dolby, 2023) has a `Separator` enum accepting
  `Length | LongStartSequence | ShortStartSequence | StartSequence` — it eats NVENC Annex-B
  directly — plus `plihandler` (PLI **and** FIR), `rembhandler`, `pacinghandler`,
  `rtcpnackresponder`, `rtcpsrreporter`, `dependencydescriptor`. MPL-2.0, trivial Windows CI
  (`windows-latest` + msvc-dev-cmd + `choco install openssl` + NMake).
- **Version trap:** `master` is **234 commits ahead of v0.24.5** (2026-06-12) and holds ~10 months
  of unreleased work. **RTX (RFC 4588, PR #1523 merged 2026-04-15), `PacingHandler::setBitrate()`,
  abs-capture-time and RTCP FIR are on master only, not in any release.** And the Rust binding
  `datachannel` 0.16.1 sits on `datachannel-sys` 0.23.2 (2025-11-12) — two minor versions behind
  the C++ release, three behind master — so from Rust you cannot reach RTX or the adjustable pacer
  at all without forking the sys crate.
- **Memory safety is the other reason to walk away.** Not on OSS-Fuzz (`projects/libdatachannel`
  and `projects/libjuice` both 404), no in-repo fuzz harnesses, no ASan/TSan in CI — and **27
  use-after-free / crash / deadlock / memory-corruption issues since 2025-01-01**. Still open:
  #1462 (ThreadPool shutdown crash), #1387, #1386 (TSAN double mutex lock), PR #1621 (UAF in
  `libnice component_io_cb`). Recently fixed: #1567 (heap-UAF in `IceTransport::RecvCallback`,
  2026-05-21), #1622 (`RtpRtx::normalizePacket` **corrupts memory** on RTX packets with header
  extensions, 2026-08-05). Zero CVEs, but that reflects nobody looking. In a SYSTEM process
  parsing internet packets, that is the finding.
- If you took the libnice escape hatch for TURN/TCP: libdatachannel's libnice CI job runs on
  **ubuntu-latest only** — no Windows, no macOS — and vcpkg pins libnice **0.1.23**, which predates
  the 2026-08-24 fix for a **heap buffer overflow in the UDP-TURN-over-TCP receive path**
  (libnice `7b8cd71f14`, shipped in 0.1.24 on 2026-09-01). That is exactly the code path you'd be
  enabling.

**Answer to "what do serious low-latency products on it do for congestion control": nothing, or
they put the CC somewhere else.** Four postures found, and none of them is "libdatachannel adapts":
1. **Fixed bitrate — OBS Studio WHIP**, the largest shipping video user.
   `plugins/obs-webrtc/whip-output.cpp`: `H265RtpPacketizer` → `RtcpSrReporter` →
   `RtcpNackResponder` → `PacingHandler(video_bitrate * 10000, 5ms)`. **No `RembHandler`, no TWCC,
   no adaptation** — the `*10000` makes the pacer a burst smoother at 10× the encode rate, not a
   rate limiter. The bitrate never moves.
2. **Fork and hand-roll — vagon** (`vagonhq/libdatachannel`, branch `twcc-v0.21.2`): +1,489 lines
   over upstream v0.21.2, **last commit 2024-09-02**, and **+902 of those lines are in
   `examples/streamer/main.cpp`, not the library** — a delay-based-only draft-02 GCC with
   `std::cout` in the feedback path. Base is two years stale.
3. **Use it only as an ICE/DTLS/SRTP box — crossdesk/minirtc** (GPL-3.0 / LGPL-3.0, pushed
   2026-09-17). This is the instructive one: minirtc carries a near line-for-line port of
   libwebrtc's GoogCC (`src/qos/`: trendline_estimator, delay_based_bwe,
   send_side_bandwidth_estimation, aimd_rate_control, probe_controller, alr_detector,
   pacing_controller, RFC 8888 CCFB) on its *own* ICE+RTP stack — and its separate libdatachannel
   path (`src/transport/datachannel_transport.cpp`) has **zero** congestion control.
   **The one team that built a full GoogCC next to libdatachannel chose not to wire it up.**
4. **Price it and walk away — Shiguredo.** `shiguredo/sora-c-sdk` (Apache-2.0), a commercial SFU
   vendor's libdatachannel-based C SDK meant to replace libwebrtc, listed GCC and transport-wide-cc
   as paid priority features. **Archived 2025-05-11.** Nobody bought it.

**Requirement 3 fails, requirement 5 fails twice, requirement 8 is weak. Reject.**

### (d) libwebrtc — "best protocol behaviour, worst build/maintenance burden"

> **REFUTED on the burden half, and by a wider margin than expected.** The work you were going to
> do — a `webrtc::VideoEncoder` passthrough shim plus a Rust binding — **already exists, merged,
> with H.265 on, with Windows x64 prebuilts, and with a zero-playout-delay switch.**

**LiveKit `rust-sdks` shipped a pre-encoded passthrough path on 2026-07-14 (PR #1223).**
Independently verified against `main` on 2026-09-17:

- `libwebrtc/src/video_source.rs` exposes:
  `NativeVideoSource::new_encoded(resolution)`, `capture_encoded_frame(&EncodedVideoFrame)`,
  `take_keyframe_request() -> bool`, `take_rate_control_request() -> Option<EncodedRateControl>`.
  `EncodedVideoFrame { codec: H264|H265|VP8|VP9|AV1, payload: &[u8], timestamp_us, frame_type,
  resolution, frame_metadata }`. That is **requirement 2 and the PLI→IDR and BWE→bitrate loops,
  in safe Rust, already written.** [verified: raw.githubusercontent.com/livekit/rust-sdks/main/libwebrtc/src/video_source.rs, 2026-09-17]
- `webrtc-sys/src/passthrough_video_encoder.cpp` and `encoded_video_frame_buffer.cpp` both exist
  (HTTP 200). The encoder subclasses `webrtc::VideoEncoder`, forwards bytes to
  `EncodedImageCallback::OnEncodedImage` with no copy for non-AV1, maps `frame_types` →
  `request_keyframe()`, and stashes `SetRates()` for the next frame.
  Its factory matches **by codec type, not profile** — deliberately, so a High-profile H.264
  negotiation cannot be handed to a real encoder that can't consume pre-encoded frames.
  [verified: file presence 2026-09-17 + subagent source read]
- **`PeerConnectionFactory::with_zero_playout_delay()`** and `with_options(zero_playout_delay,
  enable_warp)` are public Rust API. The C++ behind it installs the field trial
  **`WebRTC-ForcePlayoutDelay/min_ms:0,max_ms:0/`** — i.e. libwebrtc stamps
  `playout-delay min=0,max=0` on every outgoing packet. **Requirement 4's hardest item, done.**
  `enable_warp` additionally turns on `WebRTC-IceHandshakeDtls` (DTLS-in-STUN / SPED) for faster
  setup. [verified: webrtc-sys/src/peer_connection_factory.cpp lines 50–90, main, 2026-09-17]
- **Standalone use is possible**: `PeerConnectionFactory::create_peer_connection(config:
  RtcConfiguration)` is public and `RtcConfiguration { ice_servers: Vec<IceServer>, … }` is the
  ordinary WebRTC config — **you do not need the LiveKit SFU**. Caveat: every example in the repo
  goes through `Room::connect`, and there is no documentation endorsing standalone use.
  [verified: libwebrtc/src/peer_connection_factory.rs, main, 2026-09-17; the *support* status is
  inference]
- **Windows x64 prebuilt, downloaded at build time.** `WEBRTC_TAG = "webrtc-89d790b"` (release
  published 2026-08-19), `webrtc-win-x64-release.zip` **114.4 MB**; `LK_CUSTOM_WEBRTC` overrides.
  CI matrix includes `windows-latest / x86_64-pc-windows-msvc`.
  [verified: webrtc-sys/build/src/lib.rs, main, 2026-09-17]
- **H.265 is compiled in.** `webrtc-sys/libwebrtc/.gclient` pins
  `https://github.com/webrtc-sdk/webrtc.git@m150_release`, whose `webrtc.gni` sets
  `rtc_use_h265 = true` in the non-Chromium branch.
  [verified: .gclient on main 2026-09-17 + webrtc-sdk/webrtc m150_release webrtc.gni]
- **The CRT question is settled and checked in.** `.cargo/config.toml` on `main`:
  ```toml
  [target.x86_64-pc-windows-msvc]
  rustflags = ["-C", "target-feature=+crt-static"]
  ```
  So yes, libwebrtc's `/MT` forces Rust `+crt-static`; the failure otherwise is
  `LNK2038: mismatch detected for 'RuntimeLibrary'`. It is a **workspace-wide, target-wide** flag —
  everything in the dependency tree gets it, and you cannot then consume or produce dynamic-CRT
  DLLs. There is also a documented debug-build trap: *"On Windows, Rust doesn't link against
  libcmtd on debug, which is an issue"* — use release libwebrtc always.
  [verified: .cargo/config.toml, main, 2026-09-17 + webrtc-sys/build/src/lib.rs comment]
- crates.io: `libwebrtc` 0.3.48 (2026-09-11), 2.62 M downloads; `webrtc-sys` 0.3.45.
  No production-readiness disclaimer in the README. [verified: subagent, 2026-09-17]

**What LiveKit does NOT give you:**
- **No Rust hook to register an arbitrary `VideoEncoderFactory`**, and **no `FrameTransformer` /
  `RTCRtpScriptTransform` binding**. You get their fixed factory with a `PreEncoded` backend
  (selected via an SDP param `x-livekit-video-encoder-backend=preencoded`). Anything else means
  forking `webrtc-sys`.
- **No fan-out.** `PassthroughVideoEncoderFactory::Create()` returns a fresh encoder per
  PeerConnection — correct for publish-to-SFU, wrong for our 1→N direct model. See below.

**Upstream libwebrtc H.265 is OFF by default** in a standalone build:
```gn
if (build_with_chromium) { rtc_use_h265 = enable_hevc_parser_and_hw_decoder }
else                     { rtc_use_h265 = proprietary_codecs }   # false by default
```
Every distribution that gives you H.265 patches or forks this.
[verified: searchfox Firefox-vendored webrtc.gni + Shiguredo `patches/h265.patch` + webrtc-sdk fork;
googlesource itself 503s to automated fetches — corroborated across three independent copies]

**Prebuilt landscape, 2026-09-17:**

| Distribution | Windows x64 | Size | H.265 | Licence / terms |
| --- | --- | --- | --- | --- |
| **LiveKit `webrtc-sys`** | yes, auto-download | 114 MB | **yes** (m150) | Apache-2.0; active; no support disclaimer |
| **Shiguredo `webrtc-build`** (now `shiguredo-webrtc-build/webrtc-build`) | yes | **745 MB** | **yes** — `patches/h265.patch` flips `rtc_use_h265 = true` and fixes the VPS parser | Apache-2.0, but *"we will not respond to PRs or issues that have not been discussed on Discord. Discord is only available in Japanese."* Latest-libwebrtc tracking and bug fixes on some branches are **paid only**. Latest `m154.8037.1.2`, 2026-09-16 |
| **shiguredo/sora-cpp-sdk** | yes | 141 MB | **yes**, with real NVENC / Intel VPL / AMD AMF encoders incl. H.265 (AMF marked 非推奨/deprecated — unstable drivers) | Apache-2.0; 2026-09-17 |
| **webrtc-sdk/webrtc** | source; prebuilts via `webrtc-sdk/webrtc-build` | 221 MB | **yes**, `rtc_use_h265 = true` | the fork LiveKit consumes; m150_release, 2026-09-09 |
| **crow-misia/libwebrtc-bin** | yes | 130 MB | **unverified** — no H.265 patch found; assume upstream default (off) | tag 152.7977.0.0, 2026-08-11 |
| **Microsoft MixedReality-WebRTC** | — | — | — | **ARCHIVED**, last push 2022-03-21. Do not use. |

Shiguredo's Windows GN args are notable for a shim author: `use_rtti=true` (so `dynamic_cast`
works across the boundary) and `use_custom_libcxx=false` (MSVC STL, not hermetic libc++ — far
friendlier than the Linux build).

**Licensing note worth keeping:** Shiguredo state they contacted Via LA (H.264) and Access Advance
+ Via LA (H.265) and were told that shipping binaries that only use hardware accelerators needs no
licence. That matches Swoop's model (we never ship a software H.26x encoder or decoder), but it is
their legal read, not ours. [verified: shiguredo-webrtc-build README, 2026-09-16 — **treat as a
datapoint, not advice**]

**Chrome's own H.265 posture, from the Intent to Ship** (blink-dev thread `3h8lL8a377c`):
`WebRtcAllowH265Send` + `WebRtcAllowH265Receive`, on by default from M136 on all six Blink
platforms, and explicitly *"H265 encoding is only available if the user's device and operating
system provide the necessary capabilities as **we will not provide a software implementation to
fall back to**."* Stated hardware coverage: **75% Windows**, 99% macOS, 86% Android.
So ~25% of Windows viewers get no H.265 at all, on top of all Edge and all Firefox.
[verified: chromestatus feature 5153479456456704 API + blink-dev Intent to Ship]

**Annex-B is confirmed the required input.** `modules/rtp_rtcp/source/rtp_packetizer_h265.cc`
(m150) iterates `H264::FindNaluIndices(payload)`, which scans for Annex-B start codes — so NVENC /
AMF / QSV output goes in unmodified. [verified: m150 source]

#### Fan-out: the one place libwebrtc actively fights us

There is no shared-encoder API. `VideoEncoderFactory::Create()` is called once per PeerConnection
per codec, so the naive build is N encoders. The canonical WebRTC-discuss answer (Alvestrand,
Davies, Miniero, Oct 2018) is *"video encoding is done on a per peer connection basis… use an
SFU"*, because each peer's BWE wants its own bitrate.

**Unreal Pixel Streaming solves it in-process and the pattern is copyable**
(`VideoEncoderFactorySingleLayer.cpp` / `VideoEncoderSingleLayerHardware.cpp`, UE 5.3): the factory
keeps an `ActiveEncoders` list of N lightweight `webrtc::VideoEncoder` shims (one per
PeerConnection, as libwebrtc demands), one real hardware encoder feeds the factory, and
`FVideoEncoderFactorySingleLayer::OnEncodedImage` fans the single `EncodedImage` to every shim,
with a `StreamId` selecting which shims receive which stream.

The three costs Unreal pays, which Swoop would inherit:
1. **Rate control collapses to one number.** N BWEs call `SetRates` on N shims; you merge them into
   one target. The slowest peer sets the bitrate unless you clamp.
2. **Keyframes are global.** A new peer joining forces an IDR that every existing peer also eats.
   Unreal's own comment: *"ideally we want to make the first frame of new peers a keyframe but we
   dont know when webrtc will decide to start sending out frames… delaying it a few frames seems
   to have worked."*
3. **NVENC session limits.** Unreal queries NVML (`NvmlEncoder::GetEncoderSessionCount`) and
   **falls back to VP8 software** when consumer-GeForce concurrent-session caps are hit.

[verified: UE Pixel Streaming source + discuss-webrtc thread `SZAngREoysk`, Oct 2018]

**Net verdict on (d):** the *build* burden is now small (one `cargo build`, one prebuilt
download, one `+crt-static` line). The *maintenance* burden is real but different from what the
earlier pass assumed: you are pinned to someone else's libwebrtc milestone cadence, you inherit a
745 MB / 114 MB binary blob you cannot audit, and you carry a C++ attack surface in a process
running as SYSTEM. Requirement 8 is where libwebrtc loses, not requirement 10.

### (e) GStreamer `webrtcsink` — "has GCC congestion control and multi-consumer support"

> **CONFIRMED — and the claim actually understates it. The correct shape for Swoop is not
> `webrtcsink` at all; it is `webrtcbin` + the standalone `rtpgccbwe` element.**

GStreamer 1.28.7 (2026-09-07) is current stable.

**The GCC is real, spec-faithful, and MPL-2.0 — and it is a separate element.**
`rtpgccbwe` lives in `gst-plugin-rtp` (`net/rtp/src/gcc/imp.rs`, **1 478 lines**), not in
webrtcsink. Its own doc comment says exactly what we need:
> *"Implements the Google Congestion Control algorithm (draft-ietf-rmcat-gcc-02)… **This element
> implements the pacing as described in the spec by running its own streaming thread on its
> srcpad.** It implements the mathematics as closely to the specs as possible and sets the
> `rtpgccbwe:estimated-bitrate` property each time a new estimate is produced. User should connect
> to the `rtpgccbwe::notify::estimated-bitrate` signal to make the encoders target that new
> estimated bitrate."*

Arrival-group accumulation (`BURST_TIME` 5 ms), inter-arrival/inter-departure delay variation, an
adaptive over-use threshold clamped to [6, 600] per §5.4, β=0.85 decrease per §5.5, a pluggable
estimator (**Kalman default, or linear-regression/trendline**), and a loss-based controller
alongside. Attach it to plain `webrtcbin` via the `request-aux-sender` signal (since 1.22).

**`webrtcsink`'s `congestion-control` property** does default to `gcc` (values: `disabled`,
`homegrown`, `gcc`), and it accepts pre-encoded input on its sink pads — `video/x-h264`,
`video/x-h265`, `video/x-vp8`, `video/x-vp9`, `video/x-av1` (MR !2273, merged 2025-06-09;
H.264 profile/level negotiation for encoded input in MR !2658, 2026-02-13). Multi-consumer fan-out
is via `gst_utils::StreamProducer` (appsink → N appsrc), and with pre-encoded input it is a genuine
1-encode → N-payloaders. (Note: for *raw* input, *"encoding is not shared between consumers"*.)

**But webrtcsink cannot actuate bitrate on pre-encoded input.** `VideoEncoder::new()` returns
`None` when there is no encoder in the chain, so `session.encoders` stays empty and the
`notify::estimated-bitrate → set_bitrate()` callback becomes a no-op. The official docs say it
plainly: *"webrtcsink supports ingesting pre-encoded streams (H.264, H.265, VP8, etc), however, it
cannot perform the relevant congestion control for you."* And the README: *"webrtcsink wants to
reserve control over the bitrate for congestion control. If more granular control is required,
applications should use `webrtcbin` directly."*

→ **The right pipeline is `appsrc ! h265parse ! rtph265pay ! webrtcbin` (one per peer) plus our own
`rtpgccbwe` on `request-aux-sender`.** We then hold the encoder actuator ourselves. That is a
better fit than webrtcsink and it keeps the GCC.

**TURN over TCP and TLS:443: fully supported, verified in source.**
`gst-plugins-bad/gst-libs/gst/webrtc/nice/nice.c:521-546` maps `turns://` →
`NICE_RELAY_TYPE_TURN_TLS`; `turn://…?transport=tcp` → `NICE_RELAY_TYPE_TURN_TCP`; a bare `turn://`
with no transport registers **both** UDP and TCP. `webrtcbin`'s `turn-server` property and
`add-turn-server` action signal both take `turn(s)://user:pass@host:port`.
libnice is dual **LGPL-2.1-or-later OR MPL-1.1** — we may elect MPL. 0.1.24 released 2026-09-01
(use ≥0.1.24: 0.1.23 predates the 2026-08-24 heap-overflow fix in the UDP-TURN-over-TCP receive
path).

**Latency is not the problem people assume.** There is **no send-side jitterbuffer** —
`rtpjitterbuffer` is only instantiated on receive sessions, and `webrtcbin`'s `latency` property
(default 200 ms) affects receive only. The only deliberate outbound delay is `rtpgccbwe`'s pacer,
waking on a 5 ms single-shot clock — the same cost any spec pacer has. webrtcsink already sets
the low-latency payloader defaults (`aggregate-mode=zero-latency`, `config-interval=-1`,
`mtu=1200`). The one public "GStreamer is slow" complaint (Discourse #254, Oct 2023, ~300 ms vs
aiortc's ~130 ms) **was retracted by the reporter**, who attributed it to setup.

**Why it still isn't first choice:**
1. **No playout-delay extension, anywhere in GStreamer.** A repo-wide search for `playout-delay`
   returns **0 results**; the shipped `GstRTPHeaderExtension` implementations are `colorspace`,
   `ntp`, `mid`, `twcc`, `streamid`, `repairedstreamid`, `clientaudiolevel`. We would write a
   ~50-line Rust `GstRTPHeaderExtension` subclass (`gstreamer-rs` exposes the subclass API) and
   `add-extension` it to `rtph265pay`; `webrtcbin`'s `_gather_extmap()` then harvests it into the
   SDP. Bounded work, but it is *the* latency lever and it is missing.
2. **`webrtcbin` has no ICE restart either.** Three `/* FIXME: deal with ICE restarts */` comments
   in `gstwebrtcbin.c` (lines 3685, 3991, 4647). **Requirement 5 partially fails** — parity with
   libdatachannel, and behind str0m / webrtc-rs / libwebrtc, all of which have it.
3. **Packaging.** Real figures: `gstreamer-1.0-msvc-x86_64-1.26.11.msi` **runtime = 84 MB**,
   merge-modules zip = 90 MB (2026-03-13). **1.26.11 is the last release that ships the
   runtime-only MSI and merge modules** — 1.28.7 is a single 502 MB combined `.exe`, so an Inno
   Setup pipeline wanting merge modules is pinned to the 1.26 line. A hand-stripped DLL set would
   be far smaller (Collabora's 2021 `gstreamer-full` data points: 49.2 MB all-plugins static,
   3.2 MB for three elements) but **no verified figure exists for this pipeline** — call it
   30–60 MB, estimated.
4. **CI landmine.** `msiexec /quiet` installs only the MSI's default feature set and silently omits
   plugins; you must pass `ADDLOCAL=ALL`. The symptom is a missing element at runtime, not a build
   error. (The usual motivation is `x264enc` from `gst-plugins-ugly` — **we don't need it, we
   encode on the GPU, and excluding gst-plugins-ugly also removes the only GPL exposure in the
   set.**) The Rust plugins *do* ship in the official Windows build (cerbero packages `rsrtp` and
   `rswebrtc`), so we don't build them ourselves.
5. **Licence bookkeeping.** LGPL-2.1+ for core / plugins-good (`rtph265pay`, `rtpbin`) /
   plugins-bad (`webrtcbin`, `dtls`, `srtp`, `sctp`, `h265parse`); MPL-2.0 for `webrtcsink` and
   `rtpgccbwe`; BSD for libsrtp and usrsctp. Dynamic linking plus relink rights and licence texts
   satisfies it — standard for every commercial GStreamer shipper, but a per-release chore.
6. **Framework impedance.** A whole pipeline framework, its threading model and its bus inside a
   Rust Windows service, for what is ultimately a packetizer plus a congestion controller.

**Not a candidate today: `webrtcbin2`** (`net/webrtcbin2`, split `webrtcsend`/`webrtcrecv`, Rust,
first in the 1.29.2 snapshot, Centricular devlog 2026-05-21) — rebuilt for SFU scale, but
**currently missing retransmissions, FEC, data channels, renegotiation, statistics and TURN
servers.**

**Keep GStreamer as the contingency**, and note that if we ever need FEC *and* GCC *and* TURN-TLS
in one box tomorrow, `webrtcbin + rtpgccbwe` is the only option here that has all three shipping.

### (f) Everything else credible in 2026

**Pion (Go) — the strongest "other", and the only stack that has demonstrably solved *both* our
hard problems already.**
- `pion/webrtc` v4.2.20 (2026-09-04), `pion/interceptor` v0.1.49 (2026-09-15),
  `pion/turn` **v5.1.2** (2026-09-15), `pion/rtp` v1.10.5. All MIT, ~weekly cadence.
- **H.265 fixed *because of* Chrome.** Issue #3137 ("HEVC/h265 doesn't work properly", opened
  2025-06-01) was closed 2026-01-04 by "Fix H265Payloader (#350)". Collaborator cnderrauber's
  diagnosis in discussion #3136 (2025-07-01) is the money quote:
  > *"Chrome requires the vps&pps&sps to be packetize as an single rtp packet (Aggregation)."*
  The current payloader keeps an `h265ParamSetCache` keyed by (NAL type, param-set id), drops
  AUD/filler, and prepends cached VPS/SPS/PPS to the next VCL NAL as an aggregation packet.
  Further hardening 2026-07-17/18 ("Cache SPS/PPS/VPS", "Support multiple sps/pps/vps in h265 AU").
  [verified: pion issues/discussions + source]
- **GCC wired to an external encoder.** `pion/interceptor/pkg/gcc` (`kalman.go`,
  `overuse_detector.go`, `adaptive_threshold.go`, `slope_estimator.go`, `delay_based_bwe.go`,
  `loss_based_bwe.go`, `rate_controller.go`, `leaky_bucket_pacer.go`) behind
  `BandwidthEstimator { GetTargetBitrate() int; OnTargetBitrateChange(fn) }`. Plus `pkg/twcc`,
  `pkg/pacing`, `pkg/nack`, `pkg/ccfb` + `pkg/rfc8888`, `pkg/flexfec`, `pkg/intervalpli`.
  Caveat: `pkg/gcc` has had no functional commits since 2025-09-22.
- Best TURN matrix of anything here: `pion/turn` v5 examples cover udp, tcp, **tcp-alloc (RFC
  6062)**, **tls**, ipv6, mutual-TLS. `pion/ice` has `turnTransportProtocols`, a `TURNDialer`
  documented for TLS/DTLS, `SchemeTypeTURNS`, ICE-TCP active/passive with `TCPMux`, mDNS via
  `pion/mdns/v2`, ICE restart.
- `pion/rtp` ships `playoutdelayextension.go` **and** `abscapturetimeextension.go`.
- Gotchas: the default H.265 `RTPCodecParameters` has an **empty `SDPFmtpLine`** (so register your
  own with `profile-id`/`tier-flag`/`level-id`/`tx-mode`), and `transport-cc` is **not** in the
  default `videoRTCPFeedback` — you must call `ConfigureTWCCSender()`.
- **The Go tax.** Go 1.26's Green Tea collector keeps max pauses "typically below the millisecond
  level", which is survivable — but `H265Payloader.Payload()` allocates per access unit and per
  emitted packet, so at 1440p120 the allocation *rate* is the risk, not the collector. cgo in a
  SYSTEM service (Go runtime, thread parking, signal handling inside our process) is a bad idea;
  a **localhost sidecar over shared memory** is the sane shape, at the cost of a second binary to
  install, sign, supervise and self-update — which, given Owlette's installer constraints, is not
  nothing.
- Production: LiveKit (H.265 publish merged into `server-sdk-go` 2026-09-04, PR #996), Galene,
  Neko, Broadcast Box, Nimble Streamer. **Cloudflare Realtime/Calls on Pion is unverified — no
  public evidence; do not assume it.**

**Rust sans-IO building blocks — real, current, and still not a project you want.**
`stun-proto` 2.0.2, `turn-types` 0.7.2, `turn-client-proto` 0.7.2, `turn-client-rustls` 0.1.1,
`turn-client-openssl` 0.1.1, `turn-client-dimpl` 0.2.0, `turn-server-proto` 0.7.2 (all 2026-07/08),
`librice`/`rice-proto`/`rice-c` 0.4.3 (2026-05-11, RFC 8445 + RFC 6544 TCP candidates + RFC 7675
consent), `sctp-proto` 0.10.4, `dimpl` 0.7.3 (**DTLS 1.2 *and* 1.3**, sans-IO, sync).
Dead: `rtp-rs` (2021), `srtp` (2020), `webrtc-dtls` (2025-05, superseded by dimpl).
ystreet is the GStreamer/Pexip ICE maintainer and librice had PRs merging 2026-09-11 — this is not
a hobby stack. **But** "str0m + a TURN crate" undersells the work: allocation lifecycle and
refresh, permissions vs channel bindings with 10-minute refresh, relay effect on priority and
nomination, RFC 4571 framing for ICE-TCP, TLS resumption and reconnect on a dropped 443 connection,
consent freshness across the relay, and ICE restart re-allocating everything.
**Realistic: 3–6 engineer-weeks to a working TURN/TCP/TLS:443 path, plus an open-ended interop tail
against coturn / Cloudflare TURN / Twilio and real corporate middleboxes.** Using librice instead
means *replacing* str0m's ICE, not augmenting it. Building the whole stack from primitives is a
multi-quarter project — don't.

**Amazon KVS WebRTC C SDK** — Apache-2.0, v1.20.0 (2026-08-18), actively maintained, **real H.265**
(`RtpH265Payloader.c`, and a `docs/TROUBLESHOOTING_H265_FRAMES.md` about "freeze after first
frame", i.e. they hit the parameter-set trap too). TWCC exists but the estimator is
**"EMA-smoothed OLS linear regression"** over inter-packet delay with an AIMD controller in the
*sample* app — not GCC, and no pacer. **Windows is a second-class target** (`-DPARALLEL_BUILD`
disabled, libwebsockets needs extra CMake flags, README says "tested on Linux/MacOS"). Separable
from AWS in principle, entangled in practice. Rejected.

**One-liners:** mediasoup (ISC) — server SFU, not a sender. libmediasoupclient (ISC) — a wrapper
*around libwebrtc*, so it inherits what we're avoiding. Janus — **GPL-3.0**, and a gateway anyway.
aiortc (BSD-3) — Python/GIL, no GPU path, no GCC; fine as a test peer. werift (MIT) — genuinely
good TypeScript stack, but Node runtime + no GCC + unverified H.265. Red5 / Ant Media — Java
servers. Millicast/Dolby — closed-source vendor SDK, and Dolby is steering users to OptiView.
MixedReality-WebRTC — archived 2022.

**Media over QUIC: not yet, for a structural reason.** Safari 26.4 shipped WebTransport
(2026-03-24), making it Baseline across all major browsers, and Cloudflare's `moq-rs`
(MIT/Apache-2.0) runs relays on 330+ POPs with a provisioning API since 2026-07-31. Eleven vendors
interopped at NAB 2026. **But MoQ is publish/subscribe through a relay — there is no NAT traversal
and no browser-to-host direct path** (P2P is "via Iroh, native only"). Every byte of a desktop
stream would transit a relay, which is exactly what ICE gives us for free on a LAN. Spec is still
draft (-16 Jan 2026, -17 Mar 2026) with APIs explicitly subject to change. **Revisit in 12–18
months.**

#### The finding that deserves its own decision: nobody in this space is using RTP media tracks

Three independent Parsec-class projects, in three languages, converged on **encoded frames over a
data channel + WebCodecs in the browser**, not a WebRTC video track:

- **MoonlightWeb** (`linckosz/moonlight-web`, C++/Qt/MSVC, pushed 2026-09-16) runs as a **Windows
  service that starts capture in the console session as the logged-on user** — our exact
  constraint. Its README: *"captures a GPU surface and hands it straight to the GPU encoder in the
  same process that already holds the WebRTC PeerConnection: capture → encode (zero-copy) →
  SCTP/DTLS → browser. There is no loopback network hop, **no RTSP, no RTP, no FEC** and no second
  layer of AES on a link DTLS already encrypts."* Measured **0.06 ms to acquire + 3.46 ms to
  encode** at 1440p on an RTX 5060 Ti; *"under 20 ms glass-to-glass over Wi-Fi on a LAN."*
  H.264/HEVC/AV1 on NVENC/AMF/QuickSync/VA-API/VideoToolbox; browser decodes in WebCodecs + WebGPU.
  Transport is libdatachannel.
- **Selkies** (MPL-2.0, pushed 2026-09-17) — *"By default it delivers the stream over plain
  WebSockets to a WebCodecs-based web client; WebRTC is available as an opt-in transport."* They
  **deleted** their GStreamer `webrtcbin` pipeline in favour of `pixelflux` (Rust/PyO3 capture +
  encode).
- **RustDesk** (AGPL-3.0) — WebRTC transport merged 2026-09-05 (PR #15684, webrtc-rs 0.13, 53
  commits) carries **everything over SCTP data channels**, not media tracks.
- Counterexample: **Neko** (Apache-2.0, 22.3k stars) does use real Pion media tracks.

**Why this matters:** the data-channel + WebCodecs route deletes our three hardest requirements —
no RFC 7798 packetizer to get right, no Chrome HEVC fmtp negotiation, no playout-delay games (you
own the buffer and can run it at zero). Chrome's WebCodecs `VideoDecoder` takes HEVC Annex-B with
hardware decode directly, **and WebCodecs HEVC decode is available in Edge and (behind flags) more
widely than WebRTC HEVC is** — which would sidestep §0's browser matrix entirely.
The price: you inherit congestion control, loss recovery and frame pacing yourself; reliable+ordered
SCTP head-of-line-blocks on a lossy link, so you need unreliable/unordered plus your own
retransmit policy and your own bitrate controller off RTT and send-buffer depth.
**This is a genuine fork in the road that the brief did not scope, and it should be a day-1 side
experiment in the spike, not a decision deferred.** [verified: the three repos above, 2026-09-16/17;
the Edge/WebCodecs claim is **inference** and needs checking]

---

## 5. (g) What a non-libwebrtc sender must do for Chrome's lowest-latency path

All of the following is read straight out of libwebrtc `m137_release` (the `webrtc-sdk/webrtc`
mirror; `webrtc.googlesource.com` 503s to automated fetches). Verified 2026-09-17.

### 5.1 playout-delay — the single highest-value knob

- **URI:** `http://www.webrtc.org/experiments/rtp-hdrext/playout-delay`
- **Wire format:** 3 bytes, two 12-bit fields, **10 ms granularity**, max `0xFFF * 10ms = 40950 ms`.
  [verified: `modules/rtp_rtcp/source/rtp_header_extensions.h` class `PlayoutDelayLimits`]
- **Semantics**, verbatim from `api/video/video_timing.h`:
  > *"min = max = 0 indicates that the receiver should try and render frame as soon as possible.
  > min = x, max = y indicates that the receiver is free to adapt in the range (x, y) based on
  > network jitter."*
  Default when the extension is absent: `min_ = TimeDelta::Zero()`, `max_ = kMax` (40950 ms) —
  i.e. the jitter buffer is fully free to grow.

- **The low-latency path trigger** (`modules/video_coding/timing/timing.cc`):
  ```cpp
  bool VCMTiming::UseLowLatencyRendering() const {
    return min_playout_delay_.IsZero() &&
           max_playout_delay_ <= kLowLatencyStreamMaxPlayoutDelayThreshold;  // 500 ms
  }
  ```
  and when it is true, `RenderTimeInternal()` returns `Timestamp::Zero()` — *"Render as soon as
  possible or with low-latency renderer algorithm."*

- **The detail that decides between `max=0` and `max=anything else`.** In `MaxWaitingTime()`:
  ```cpp
  if (render_time.IsZero() && zero_playout_delay_min_pacing_->us() > 0 &&
      min_playout_delay_.IsZero() && max_playout_delay_ > TimeDelta::Zero()) {
      // limit the interframe delay to |zero_playout_delay_min_pacing_|
  ```
  with `constexpr TimeDelta kZeroPlayoutDelayDefaultMinPacing = TimeDelta::Millis(8);`.
  **So `min=0, max>0` still imposes an 8 ms minimum between decodes. `min=0, max=0` skips that
  branch entirely and frames go straight to the decoder.** At 120 fps (8.3 ms frame interval) that
  8 ms pacer is the difference between smooth and permanently one frame behind. Send **min=0,
  max=0**, on every video packet. (Overridable via field trial `WebRTC-ZeroPlayoutDelay/min_pacing:Xms/`,
  but we can't set field trials in someone else's browser.)

- **`max=0` also overrides the receiving page.** `video/video_receive_stream2.cc` computes
  `minimum_delay = max(frame_min, base_min, syncable_min)` and then:
  ```cpp
  if (frame_maximum_playout_delay_.has_value() && minimum_delay > *frame_maximum_playout_delay_) {
      minimum_delay = *frame_maximum_playout_delay_;
  ```
  `base_minimum_playout_delay_` is what `RTCRtpReceiver.jitterBufferTarget` /
  `playoutDelayHint` feed (`SetBaseMinimumPlayoutDelayMs`). **Sending max=0 clamps any
  receiver-side buffering request back to 0** — the sender wins. Conversely, if the page sets
  `jitterBufferTarget > 0` and we send no playout-delay extension, we lose the low-latency path.
  Set the extension; optionally also set `jitterBufferTarget = 0` in our JS client for belt and
  braces.

- **Chrome offers playout-delay by default** — it is in the `kSendRecv` block of
  `WebRtcVideoEngine::GetRtpHeaderExtensions()`. So it will appear in the answer's `extmap`.

### 5.2 Which header extensions Chrome will actually negotiate for video

From `media/engine/webrtc_video_engine.cc::GetRtpHeaderExtensions()`:

**Offered (`kSendRecv`)** — use these freely:
`abs-send-time`, `urn:3gpp:video-orientation`, **`transport-wide-cc` (transport-sequence-number)**,
**`playout-delay`**, `video-content-type`, **`video-timing`**, `color-space`, `mid`, `rid`,
`repaired-rid` (and `toffset` earlier in the same block).

**NOT offered (`kStopped`)** — do not plan around these:
- `corruption-detection`
- **`abs-capture-time`** — hardcoded `kStopped`, no field trial. **Requirement 4's
  abs-capture-time is not achievable against stock Chrome.** If we put it in our offer, Chrome's
  answer omits it and Chrome ignores it on the wire. [verified: source; the exact answer-side
  filtering behaviour is **inference** from `RtpHeaderExtensionsFromCapabilities`]
- `generic-frame-descriptor` — field trial `WebRTC-GenericDescriptorAdvertised`
- **`dependency-descriptor`** — field trial `WebRTC-DependencyDescriptorAdvertised`. Independent
  corroboration: *"Chrome doesn't offer or negotiate the Dependency Descriptor extension by
  default, even though it's available"*, and enabling it needs
  `--force-fieldtrials=WebRTC-DependencyDescriptorAdvertised/Enabled/`.
  [verified: source + Chromium issue 40191093 + Meetecho AV1-SVC write-ups]
- `video-layers-allocation` — field trial

**Practical extension set for Swoop:** `transport-wide-cc` (mandatory — it is what drives our GCC),
`playout-delay` min=0/max=0 (mandatory), `abs-send-time`, `mid`, and optionally
`video-content-type` (screenshare hint) and `video-timing` (gives us glass-to-glass numbers in
`getStats` for free). **Drop abs-capture-time from the plan.**

### 5.3 What Chrome's H.265 receiver requires of the RTP stream

**This is the part most likely to bite, and it is unforgiving.**

`modules/video_coding/h26x_packet_buffer.cc::MaybeAssembleFrame()`:
```cpp
} else if (packet->codec() == kVideoCodecH265) {
    ...
    has_idr |= (nalu_type >= kBlaWLp && nalu_type <= kRsvIrapVcl23);
    has_vps |= nalu_type == kVps;
    has_sps |= nalu_type == kSps;
    has_pps |= nalu_type == kPps;
  }
  if (has_idr) {
    if (!has_vps || !has_sps || !has_pps) {
      return false;     // not a keyframe -> frame is dropped
    }
  }
```
and the header states, flatly:
```cpp
// |h264_idr_only_keyframes_allowed| is ignored if H.265 is used.
...
// Out of band supplied codec parameters for H.264.
void SetSpropParameterSets(const std::string& sprop_parameter_sets);
```

**Consequences, all mandatory:**
1. **Every IRAP access unit must carry VPS + SPS + PPS in-band, in the same frame.** No field
   trial relaxes it; the `sprop-*` out-of-band path is **H.264 only**. NVENC: set
   `repeatSPSPPS = 1` (or equivalent) so parameter sets are emitted with each IDR. AMF: enable
   header insertion per IDR. Get this wrong and Chrome silently drops every keyframe and you see a
   black `<video>` with a rising `framesDropped`.

   **Stronger form of the same rule, from the field:** Pion's collaborator cnderrauber, diagnosing
   the 2025 "HEVC doesn't work in Chrome" bug (discussion #3136, 2025-07-01):
   > *"Chrome requires the vps&pps&sps to be packetize as an single rtp packet (Aggregation)."*

   The packet-buffer source above accumulates `has_vps/has_sps/has_pps` across *all* packets of a
   frame, so co-packetization is not strictly required by that code path — but frame boundaries are
   found by RTP timestamp, so parameter sets sent with a *different* timestamp form their own
   IRAP-less "frame" and are discarded, and the IDR then fails the check. **An aggregation packet
   is the only shape that is unambiguously safe. Do that.**

   **Where each stack stands on this:**
   - **str0m — safe, and it caches.** `src/packet/h265.rs` holds `vps_nalu`/`sps_nalu`/`pps_nalu`,
     and *"if we have cached VPS/SPS/PPS, emit an Aggregation Packet (AP, Type=48) immediately
     before the next non-parameter-set NAL unit, per RFC 7798 §4.4.2."* It falls back to individual
     single-NAL packets only if the AP would exceed MTU — **that fallback path is the Chrome-risky
     one and is a spike test item.** [verified: source, HEAD 2026-09-17]
   - **Pion — safe, and it caches** (`h265ParamSetCache` keyed by NAL type + param-set id).
   - **webrtc-rs — safe only if your encoder repeats the parameter sets.** `HevcPayloader::payload`
     greedily aggregates consecutive small NALUs into an AP until the MTU is hit, so a
     `VPS|SPS|PPS|IDR` access unit produces `AP(VPS,SPS,PPS)` + `FU(IDR…)` at one timestamp —
     correct. **But there is no parameter-set cache**, so an encoder that emits parameter sets only
     on the *first* IDR will silently produce undecodable keyframes thereafter.
     [verified: rtc-rtp/src/codec/h265/mod.rs, HEAD 2026-09-17]

   → **Set `repeatSPSPPS` on the encoder regardless of stack.** It costs ~100 bytes per IDR and it
   makes all three implementations correct.
2. For **H.264**, the same is true by default (`!h264_idr_only_keyframes_allowed_ && (!has_sps ||
   !has_pps) → return false`), with the escape hatch that `sprop-parameter-sets` in fmtp can supply
   them out of band.
3. **Never emit PACI (type 50).** `modules/rtp_rtcp/source/video_rtp_depacketizer_h265.cc`:
   `// TODO(bugs.webrtc.org/13485): Implement PACI parse for H265`. AP (48) and FU (49) are
   supported; a stray PACI is a hard parse failure. str0m's packetizer only *parses* PACI and never
   emits it, so we are safe by default — but verify in the spike.
4. **Never advertise `sprop-max-don-diff` / never emit DONL.** `media/base/media_constants.cc`
   lists Chrome's H.265 fmtp vocabulary as exactly: `profile-space`, `tier-flag`, `profile-id`,
   `level-id`, `profile-compatibility-indicator`, `interop-constraints`, `tx-mode`. There is **no
   `sprop-max-don-diff` and no `sprop-vps/sps/pps`**. str0m defaults DONL off (`donl: None`, opt-in
   via `with_donl()`) — leave it off.
5. **fmtp to send:** `profile-id=1` (Main), `tier-flag=0` (Main tier), `level-id=180` (Level 6.0 —
   Chromium's `kLevel6`), `tx-mode=SRST`. This is verbatim what Chrome 144 offers and what str0m
   now defaults to. [verified: str0m issue #860 + `codec_config.rs`]
6. **rtcp-fb Chrome understands** (`media_constants.cc`): `goog-lntf`, `nack`, `nack pli`,
   `goog-remb`, `transport-cc`, `ccm fir`, `rrtr`. `webrtc_video_engine.cc` adds
   `ccm fir` + `nack` + `nack pli` to every codec, and **`transport-cc`** — so offer
   `a=rtcp-fb:<pt> nack`, `nack pli`, `ccm fir`, `transport-cc` and an `a=fmtp:<rtxpt> apt=<pt>`
   RTX line. `goog-remb` is optional and we should not rely on it.
7. Annex-B start codes are what libwebrtc's own packetizer consumes
   (`H264::FindNaluIndices`) — so GPU-encoder output goes in unmodified, no AVCC conversion.

### 5.4 Safari

Safari 18+ receives H.265 by default via VideoToolbox. Detail beyond that
(fmtp it emits, playout-delay support, `jitterBufferTarget`) is **not verified in this pass** —
see §8. str0m did hit and fix a Safari **H.264** negotiation bug in 2026 (issue #1015, *"H264
negotiation with Safari/WebKit fails: higher offered levels reject the codec, and Constrained High
is not recognized"*, closed 2026-08-14), which is a reminder that Safari's offer/answer is its own
interop surface. [verified: str0m issue #1015]

---

## 6. (h) Keyframe-free loss recovery with browser receivers

**Short answer: no, not usefully. Plan on PLI→IDR, and spend the effort on not losing packets.**

| Mechanism | Chrome status | Evidence |
| --- | --- | --- |
| **LNTF** (`goog-lntf`) | **VP8 only, and behind a field trial that is off by default.** | `media/engine/webrtc_video_engine.cc`: `if (codec->name == kVp8CodecName && IsEnabled(trials, "WebRTC-RtcpLossNotification")) { codec->AddFeedbackParam(FeedbackParam(kRtcpFbParamLntf, kParamValueEmpty)); }` — the `kVp8CodecName` test is unconditional. **Never offered for H.264 or H.265.** [verified: m137 source, 2026-09-17] |
| **RPSI** | **Not implemented.** `modules/rtp_rtcp/source/rtcp_packet/rpsi.h` → HTTP 404. Removed from libwebrtc years ago. | [verified: m137 mirror, 2026-09-17] |
| **Frame marking** (`draft-ietf-avtext-framemarking`) | **Never shipped.** No `framemarking` string anywhere in `media_constants.cc`. | [verified: m137 source] |
| **Dependency Descriptor** | **Codec-agnostic on the receive side — but not negotiated by default.** | see below |

**The DD result is the interesting one, and it is a near-miss.**
`modules/video_coding/rtp_frame_reference_finder.cc`:
```cpp
RtpFrameReferenceFinderImpl::ManageFrame(std::unique_ptr<RtpFrameObject> frame) {
  if (video_header.generic.has_value()) {
    return GetRefFinderAs<RtpGenericFrameRefFinder>().ManageFrame(std::move(frame));
  }
  switch (frame->codec_type()) { /* VP8, VP9, generic, default */ }
}
```
and `video/rtp_video_stream_receiver2.cc:448-506` parses `RtpDependencyDescriptorExtension` and
populates `video_header->generic` **with no codec check at all**. So *if* DD were negotiated,
Chrome would use it to track frame dependencies for H.265 and H.264 and could decode around losses
that don't touch a frame's references — meaning fewer PLIs.

**But it isn't negotiated.** DD sits at `RtpTransceiverDirection::kStopped` unless
`WebRTC-DependencyDescriptorAdvertised` is enabled, which requires a command-line flag on the
viewer's browser. We cannot set that on a customer's machine. It also needs
`a=extmap-allow-mixed` / two-byte headers because DD on a keyframe exceeds 16 bytes, and DD
requires an attached template structure on every keyframe — non-trivial to author.
[verified: `webrtc_video_engine.cc` + Chromium issue 40191093]

**Corroboration from the cloud-gaming side.** `selkies-project/pixelflux` issue #29 (opened
**2026-09-16**, open, "enhancement / help wanted"), titled *"Reference frame invalidation reaches
only NVENC and libx264; every other codec spends a key frame"*: reference invalidation is driven by
the **client reporting which frames it lost, over their own wire protocol**
(`StripeFrame.reference_frame_id` → `invalidate_reference`). On browser receivers the author is
explicit that it does not work — the decoded/lost frame number *"reaches the application only
through OpenH264's own decoder. A browser never reports it."*
`games-on-whales/wolf` issue #5 ("Implement Reference Frame Invalidation") is the same story on a
non-browser client. Parsec, GeForce NOW and Moonlight all run RFI over proprietary protocols with
native clients, not over WebRTC to a browser. [verified: the two GitHub issues, 2026-09-16 / open]

### What we can actually do instead

1. **Infer loss from TWCC, don't wait for the PLI.** transport-wide-cc feedback tells the *sender*
   exactly which RTP sequence numbers did not arrive. We know which frame each sequence number
   belonged to. So we can decide, one feedback interval (~50–100 ms) ahead of Chrome's PLI, that
   frame *N* is damaged, call `NvEncInvalidateRefFrames` for it, and encode the next frame against
   an older LTR — **provided that older LTR is one Chrome definitely has.** Chrome will still be
   missing frame *N*, so this only helps if frame *N* was a non-reference frame or if we accept a
   brief glitch rather than a full IDR. This is a real technique but it is sender-side inference,
   not a standard. [inference, built on verified TWCC semantics]
2. **Periodic intra-refresh instead of IDRs.** NVENC and AMF both support rolling intra refresh
   (waves of intra macroblocks). It removes the IDR bitrate spike that causes the
   pacer-queue latency bump. Chrome decodes it fine — it is ordinary inter-coded video — **but
   Chrome will never recognise a refresh cycle as a "keyframe"**, so the first frame after
   `addTrack` and every PLI response must still be a true IDR. Use intra-refresh *between*
   keyframes, not instead of them. [inference from NVENC docs + the h26x_packet_buffer logic above]
3. **Make loss rarer.** RTX/NACK for anything with an RTT of slack, a pacer that does not burst,
   and — the thing str0m lacks — FEC for the sub-RTT case.
4. **Answer the PLI fast.** The whole loop is PLI → our RTCP handler → encoder forced-IDR → pacer →
   wire. Budget it and measure it in the spike; a 3-frame stall is a very different product from a
   15-frame one.

---

## 7. Proposed 1-week head-to-head SPIKE

**Candidates:** **A = str0m 0.23.1 + `turn-client-proto`** (pure Rust), **B = LiveKit `libwebrtc`
0.3.48 pre-encoded passthrough** (prebuilt libwebrtc m150).

**Build one harness, two transport back-ends behind one trait.** Everything else — capture,
encode, signalling, the web client — is shared, so the comparison is honest and whichever loses
costs you only its back-end.

```rust
trait SwoopTransport {
    fn add_peer(&mut self, offer: &str) -> Result<String /*answer*/>;
    fn push_au(&mut self, peer: PeerId, au: &EncodedAu);       // Annex-B, pts, is_idr
    fn poll_events(&mut self) -> Vec<TransportEvent>;          // BitrateTarget, KeyframeRequest,
                                                               // PeerState, DataChannel
    fn send_data(&mut self, peer: PeerId, ch: ChannelId, buf: &[u8], reliable: bool);
}
```

### Day-by-day

| Day | Work |
| --- | --- |
| 1 | Shared harness: DXGI Desktop Duplication → NVENC H.265 **and** H.264 (both, in parallel — you need both for the browser matrix in §0) → `EncodedAu` ring. Minimal WS signalling server + a `<video>` page with `getStats()` polling and a `jitterBufferTarget=0` toggle. Stub transport that dumps Annex-B to disk, so the capture/encode half is proven before any WebRTC. |
| 2 | **Back-end A (str0m):** `Rtc::builder().enable_h265(true).set_rtp_mode(false)`, SDP answer, `Writer::write` per AU, `Event::EgressBitrateEstimate` → `NvEncReconfigureEncoder`, `Event::KeyframeRequest` → forced IDR. Set `playout-delay` min=0/max=0 via `ExtensionValues`. First Chrome frame on screen. |
| 3 | **Back-end B (LiveKit):** `PeerConnectionFactory::with_zero_playout_delay()`, `NativeVideoSource::new_encoded()`, `capture_encoded_frame`, `take_keyframe_request`, `take_rate_control_request`. Prove `+crt-static` links clean in GitHub Actions `windows-latest`. First Chrome frame. |
| 4 | **TURN.** A: wire `turn-client-proto` 0.7.2 + `turn-client-rustls` 0.1.1, feed relay candidates to str0m, route packets through the allocation. B: `RtcConfiguration.ice_servers` with `turns:…:443?transport=tcp`. Test both against coturn with **UDP blocked at the Windows firewall** — this is the requirement most likely to be quietly broken. |
| 5 | **Impairment matrix + data channels + N-peer fan-out.** Run the measurements below under `clumsy`/`netem`. Open a reliable and an unreliable/unordered data channel each way. Attach 4 browser peers to one host and watch what the bitrate controller does. |

### What to measure (all from `chrome://webrtc-internals` + host-side logs)

1. **Glass-to-glass latency.** Photodiode is overkill; use a millisecond clock rendered on the host
   desktop, captured by the browser tab via a second screen recording, and diff. Report p50 and p99
   over 5 minutes at 1080p60 and 1440p120.
2. **Encoder-retarget loop quality.** Step the link from 50 Mbps → 5 Mbps → 50 Mbps. Record:
   time to first bitrate reduction, overshoot (peak queueing delay during the step down), time to
   recover to ≥80% of the new capacity, and whether it oscillates.
3. **PLI→IDR→render round trip.** Drop a burst of 20 packets. Measure wall-clock from the drop to
   the first correctly rendered frame.
4. **Steady-state jitter.** `framesDecoded` inter-arrival p99 and `jitterBufferDelay`. Confirm
   `jitterBufferDelay` really is ~0 with playout-delay min=0/max=0, and confirm the 8 ms pacing
   from §5.1 is *not* present.
5. **CPU + memory on the host** at 4 peers, and **binary size** of the shipped exe.
6. **Interop matrix:** Chrome stable + Chrome beta + Edge + Safari (macOS + iOS) + Firefox,
   H.265 where offered and H.264 everywhere, each behind (a) direct, (b) TURN/UDP,
   (c) TURN/TCP:443, (d) TURN/TLS:443.

### Pass/fail thresholds

| Metric | Pass | Hard fail |
| --- | --- | --- |
| Glass-to-glass p50, 1080p60, LAN | ≤ 45 ms | > 70 ms |
| Glass-to-glass p99, LAN | ≤ 80 ms | > 150 ms |
| `jitterBufferDelay` steady state, Chrome | ≤ 5 ms | > 20 ms (means playout-delay isn't taking) |
| Time to first bitrate cut after a 10× capacity drop | ≤ 300 ms | > 1000 ms |
| Peak added queueing delay during that drop | ≤ 150 ms | > 500 ms |
| PLI → rendered good frame | ≤ 3 frame intervals | > 10 frame intervals |
| H.265 keyframes accepted by Chrome | 100% | any silent drop (the VPS/SPS/PPS trap, §5.3) |
| TURN over TLS:443 with UDP firewalled | connects, < 2 s | does not connect |
| 4 concurrent peers on one host | works; per-peer bitrate sane | one slow peer starves the others |
| GH Actions `windows-latest` cold build | ≤ 15 min | > 40 min |

### Decision rule

- If **A** passes everything: take A. Smaller, safer, MIT, no C++ in a SYSTEM process, and the
  better congestion controller.
- If A fails only on **TURN/TLS** or **mDNS**, that is engineering, not a verdict — budget another
  week and still take A.
- If A fails on **Chrome H.265 interop** or on the **congestion-control step response**, take B.
- If **both** fail the latency thresholds, the problem is the capture/encode path, not the
  transport — stop and re-measure day 1's stub numbers before blaming WebRTC.

### Things to deliberately *not* do in the spike

Don't build FEC, don't build simulcast, don't build the Dependency Descriptor, don't build
reference-frame invalidation (see §6), and don't try to share one encoder across peers on day 5 —
measure the naive per-peer cost first and find out whether it is even a problem.

---

## 8. What I could not verify

**Material to the decision:**
- **webrtc-rs TURN over TLS:443 end to end.** `rtc-ice` parses `turns:` and `?transport=tcp`, and
  the v0.20.0 announcement claims *"TURN relays including TCP/TLS variants"* — but `rtc-turn`'s own
  example shows only `TransportProtocol::UDP` and its `Cargo.toml` has no TLS dependency, so TLS
  must come from the async driver. Unconfirmed.
- **Chrome's answer-side treatment of a remote-offered `abs-capture-time`.** The capability is
  hardcoded `kStopped`, and libwebrtc's `RtpHeaderExtensionsFromCapabilities` filters those out —
  so it should be dropped from the answer. That last step is inference, not a source read.
  Settle it with one real Chrome offer/answer in the spike.
- **Safari's H.265 fmtp, playout-delay support and third-party-sender interop.** The dedicated
  browser deep-dive did not complete. Known: Safari 18+ receives H.265 by default; Safari 27 beta /
  STP 242 (2026-04-23) added `RTCRtpReceiver.jitterBufferTarget`. Everything else about Safari is
  an open question, and str0m issue #1015 (H.264 level/Constrained-High negotiation, closed
  2026-08-14) shows WebKit's offer/answer is its own interop surface. **Put Safari in the spike
  matrix on day 1, not day 5.**
- **Whether `libwebrtc`'s LiveKit crate is genuinely usable standalone.** The API is public;
  nothing documents or endorses the non-SFU path.
- **Final Windows binary size** after statically linking libwebrtc into a Rust exe, and the
  **wall-clock build time** for libwebrtc from source on Windows. No credible published figures.
- **Size of a hand-stripped GStreamer DLL set** for the `webrtcbin + rtpgccbwe` pipeline. Verified
  anchors only: 84 MB runtime MSI (1.26.11) and Collabora's 2021 49.2 MB / 3.2 MB `gstreamer-full`
  data points. My 30–60 MB is an estimate.
- **Which libnice version the official GStreamer Windows MSI bundles** — relevant to the
  2026-08-24 TURN-over-TCP heap-overflow fix.
- **Whether WebCodecs HEVC decode is available in Edge**, which is the load-bearing assumption
  under the data-channel-transport side bet in §4(f). Inference, unchecked.

**Noted but not decision-critical:**
- Chrome's exact `jitterBufferTarget` shipping milestone and its interaction with a
  sender-supplied playout-delay (the source-level clamp in §5.1 is verified; the JS-API surface
  is not).
- Whether Cloudflare Realtime/Calls is Pion-based — no public evidence; do not assume it.
- Wolf's and Nestri's WebRTC libraries.
- Pion's exact H.265 `SDPFmtpLine` requirement against Chrome M136+ (its default entry is empty).
- Whether vagon ships its libdatachannel GCC fork in production.
- Blacknut / Shadow / Immersity / netris transports — closed source.

**Corrections applied to parallel research during this pass** (recorded so they aren't re-imported
later): a parallel thread reported that webrtc-rs has *"no bandwidth estimator"* — **wrong**,
`rtc-interceptor/src/lib.rs:228-278` publicly re-exports a full `gcc::*` tree plus `flexfec`.
Another reported libdatachannel has no playout-delay support — **wrong**, it has had
`RtpPacketizationConfig::playoutDelayId/Min/Max` since PR #1152 (2024-04-01).
