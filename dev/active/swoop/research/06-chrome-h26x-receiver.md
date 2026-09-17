# Browser WebRTC receive path for a non-libwebrtc H.265/H.264 sender

**Source access caveat (read first).** `webrtc.googlesource.com` returned HTTP 503 to every request throughout this session (curl and WebFetch, with and without browser UA). I read libwebrtc from two substitutes: the GitHub mirror `webrtc-mirror/webrtc` (`main`, last upstream sync **2026-01-13**) and, for anything that changed after that date, the **Gerrit REST API at `webrtc-review.googlesource.com`**, which works and serves file content at a given merged CL (`/changes/<n>/revisions/current/files/<urlenc-path>/content`). Chromium code is from `chromium.googlesource.com/chromium/src` `main`, fresh as of today. I re-verified every load-bearing WebRTC file against its latest merged CL. Chrome Stable today is **M154** (154.0.8037.44, per chromiumdash).

---

## BOTTOM LINE

1. **Lowest-latency receive config is the `playout-delay` header extension with `min=0`, and `max` in the 10–500 ms range — not `max=0`.** `max=0` does give "render ASAP", but it also makes Chrome **fast-forward (drop) every decodable temporal unit except the newest** whenever two or more are ready, which breaks a non-scalable H.26x reference chain and triggers a PLI. `min=0, max ≤ 500 ms` gets the identical low-latency render path with no fast-forward. This is a code-level finding, not folklore — the mechanism is in `video/frame_decode_timing.cc` + `video/video_stream_buffer_controller.cc` and is spelled out below.
2. **Chrome H.265 receive is shipped and on by default since M136** (`kWebRtcAllowH265Receive` is `FEATURE_ENABLED_BY_DEFAULT` in current `media/webrtc/webrtc_features.cc`), **hardware-decode only, with no software fallback** — on a box with no HEVC HW decode, H.265 never appears in the SDP at all.
3. **Chrome's H.265 receiver has three hard, undocumented framing requirements** that kill most third-party senders: VPS+SPS+PPS in-band inside every IRAP access unit; a VPS in the first packet of any new continuous run; and the RTP marker bit only on the last packet of the access unit. No `sprop-*` escape hatch exists for H.265.
4. **There is no keyframe-free loss recovery available to you.** `goog-lntf` is VP8-only and requires the Dependency Descriptor; RPSI is not implemented in libwebrtc at all; frame-marking is not implemented at all; an intra-refresh-only stream never produces a keyframe as far as the depacketizer is concerned, so Chrome PLIs every 200 ms forever. Your only loss-recovery levers toward a browser are NACK/RTX and IDR-on-PLI. The one interesting untested option is negotiating the Dependency Descriptor for H.264/H.265 via `setHeaderExtensionsToNegotiate()` — the receive machinery is codec-agnostic (details in Q4).

---

# Q1 — Lowest-latency receive path

## 1.1 The `playout-delay` RTP header extension

**URI:** `http://www.webrtc.org/experiments/rtp-hdrext/playout-delay`
(`api/rtp_parameters.h`, `RtpExtension::kPlayoutDelayUri`). SDP `a=extmap` name in WebRTC's own docs: `playout-delay`.
Spec doc: `docs/native-code/rtp-hdrext/playout-delay/README.md` — https://webrtc.googlesource.com/src/+/refs/heads/main/docs/native-code/rtp-hdrext/playout-delay/ (mirror: https://raw.githubusercontent.com/webrtc-mirror/webrtc/main/docs/native-code/rtp-hdrext/playout-delay/README.md)

**Wire format — confirmed from `modules/rtp_rtcp/source/rtp_header_extensions.{h,cc}`, class `PlayoutDelayLimits`:**

```
 0                   1                   2                   3
 0 1 2 3 4 5 6 7 8 9 0 1 2 3 4 5 6 7 8 9 0 1 2 3 4 5 6 7 8 9 0 1
+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
|  ID   | len=2 |       MIN delay       |       MAX delay       |
+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
```
- `kValueSizeBytes = 3` (one-byte header `len` field = 2, i.e. length−1).
- 24-bit big-endian: `min_raw = raw >> 12`, `max_raw = raw & 0xFFF`. Two 12-bit fields.
- `kGranularity = TimeDelta::Millis(10)`. Range 0–4095 × 10 ms = **0–40950 ms**.
- `Parse()` rejects `min > max` (via `VideoPlayoutDelay::Set`, which returns false).
- `VideoPlayoutDelay::kMax = TimeDelta::Millis(10) * 0xFFF` (`api/video/video_timing.h`).
- **Default with no extension: `min = 0`, `max = kMax = 40950 ms`** — i.e. *not* the low-latency path. You must send the extension.

The header comment in `api/video/video_timing.h` is normative for intent: *"min = max = 0 indicates that the receiver should try and render frame as soon as possible."*

**Receive semantics — does min=0/max=0 disable the jitter buffer?**

Partly, and with a nasty side effect. Three files:

`modules/video_coding/timing/timing.cc` (current at CL 492220, merged 2026-07-30):
```cpp
constexpr TimeDelta kLowLatencyStreamMaxPlayoutDelayThreshold = TimeDelta::Millis(500);

bool VCMTiming::VideoDelayTimings::UseLowLatencyRendering() const {
  return min_playout_delay.IsZero() &&
         max_playout_delay <= kLowLatencyStreamMaxPlayoutDelayThreshold;
}

Timestamp VCMTiming::RenderTime(uint32_t rtp_timestamp, Timestamp now) const {
  VideoDelayTimings timings = GetTimings();
  if (timings.UseLowLatencyRendering()) {
    return Timestamp::Zero();      // "Render as soon as possible."
  }
  ...
}
```
So the low-latency path is triggered by **`min == 0 && max ≤ 500 ms`**, not only by `max == 0`. When it fires, `RenderTime()` returns 0: no timestamp extrapolation, no `current_delay` clamp, no render smoothing. `VCMTiming::RenderParameters()` also sets `VideoFrame::RenderParameters.use_low_latency_rendering = true`, which Chrome's compositor consumes.

`video/frame_decode_timing.cc` (current at CL 495780, merged 2026-08-13):
```cpp
static constexpr TimeDelta kMaxAllowedFrameDelay     = TimeDelta::Millis(5);
static constexpr TimeDelta kZeroPlayoutDelayMinPacing = TimeDelta::Millis(8);

TimeDelta FrameDecodeTiming::MaxWaitingTime(Timestamp render_time, Timestamp now,
                                            bool too_many_frames_queued) const {
  const VCMTiming::VideoDelayTimings timings = timing_->GetTimings();
  if (render_time.IsZero() && timings.min_playout_delay.IsZero() &&
      timings.max_playout_delay > TimeDelta::Zero()) {          // <-- note: max > 0
    if (too_many_frames_queued) return TimeDelta::Zero();
    ... pace at kZeroPlayoutDelayMinPacing ...
  }
  return render_time - now - timings.estimated_max_decode_time - timings.render_delay;
}

std::optional<FrameSchedule> FrameDecodeTiming::OnFrameBufferUpdated(...) {
  ...
  if (max_wait <= -kMaxAllowedFrameDelay && next_temporal_unit_rtp != last_temporal_unit_rtp) {
    return std::nullopt;   // "Fast-forwarded frame"
  }
  ...
}
```
and `video/video_stream_buffer_controller.cc`:
```cpp
while (decodable_tu_info) {
  schedule = decode_timing_.OnFrameBufferUpdated(...);
  if (schedule) { ...ScheduleFrame...; return; }
  buffer_->DropNextDecodableTemporalUnit();      // <-- drops the frame
  decodable_tu_info = buffer_->DecodableTemporalUnitsInfo();
}
```

**The consequence, spelled out:**

| sender sends | `UseLowLatencyRendering` | `MaxWaitingTime` | behaviour |
|---|---|---|---|
| no extension (`0 … 40950`) | false | positive, jitter-estimate driven | full render smoothing, target delay from the jitter estimator |
| `min=0, max=0` | **true** | `0 − now − decode − render_delay` → hugely negative | render ASAP, no pacing — **but `max_wait ≤ −5 ms` is always true, so whenever ≥2 temporal units are decodable at once, all but the newest are dropped via `DropNextDecodableTemporalUnit()`** |
| `min=0, 0 < max ≤ 500 ms` | **true** | the pacing branch → always ≥ 0 | render ASAP, never fast-forwards, decodes paced at ≥ `kZeroPlayoutDelayMinPacing` |
| `min=0, max > 500 ms` | false | normal | back to smoothed rendering |

For a non-scalable H.264/H.265 stream, a dropped frame breaks the reference chain → the next frames become undecodable → `keyframe_required_` → PLI. Two frames become decodable at once routinely after a NACK repair or a decoder hiccup. **Recommendation: `min=0, max=100` (or anything 10–500 ms).** You get the identical `RenderTime()==0` render-ASAP path without the fast-forward.

**What playout-delay does *not* do:** it does not disable the packet buffer, NACK, frame-completeness assembly, or the reference/decodability checks. It removes the *target playout delay and render smoothing*. The `H26xPacketBuffer` still requires a complete, in-order, marker-bit-terminated access unit before anything reaches the decoder.

**One Chrome-specific wrinkle worth verifying on your target build.** Chromium's checked-in field-trial testing config (`testing/variations/fieldtrial_testing_config.json`, `main` today) contains:
```json
"WebRTC-ZeroPlayoutDelay": [{ "platforms": ["windows","mac",...],
  "experiments": [{ "name": "min_pacing:0ms,max_decode_queue_size:8," }]}]
```
WebRTC parses the *group name* as the field-trial string, so in Chrome **`kZeroPlayoutDelayMinPacing` is 0 ms, not 8 ms**. But WebRTC **deleted that field trial on 2026-08-13** (CL https://webrtc-review.googlesource.com/c/src/+/495780, "Remove WebRTC-ZeroPlayoutDelay field trial… promotes its default parameters to constants: Min pacing: 8 ms"). So Chrome builds that pick up that WebRTC roll (≈M156+) will go back to 8 ms pacing in the `min=0, max>0` case. `min=0,max=0` bypasses pacing entirely in both cases. Flagging this as a real behaviour change you should measure rather than assume. *(Caveat: `fieldtrial_testing_config.json` is the checked-in test/unbranded config; Chrome's real Finch state is server-side and not public.)*

**Changes in M13x/M14x:** the min=0/max=0 semantics are unchanged. `timing.cc` was heavily refactored between 2026-05 and 2026-08 (`VideoJitterTimingInterface`, `DefaultVideoJitterTiming`; `MaxWaitingTime` moved out to `video/frame_decode_timing.cc` in CL 470040, 2026-05-08), but `UseLowLatencyRendering()`, the 500 ms threshold, and the `render_time==0` short-circuit are byte-for-byte the same logic. Last *behavioural* change to this path was CL "Fix video renderer slowdown by wrong RenderTime" (2024-11-13).

**Receiver-side override you can't control but should know about:** field trial `WebRTC-ForcePlayoutDelay` (`min_ms`, `max_ms`) in `video/rtp_video_stream_receiver2.cc` replaces the extension's values outright when set.

## 1.2 `RTCRtpReceiver.jitterBufferTarget`

**Spec:** it moved out of webrtc-extensions into **webrtc-pc** (w3c/webrtc-pc PR #2953). Current text: `attribute DOMHighResTimeStamp? jitterBufferTarget;` on `RTCRtpReceiver`, `[[JitterBufferTarget]]` internal slot initialised to null, **`RangeError` if negative or > 4000 ms**, and the UA "MUST have a minimum allowed target and a maximum allowed target reflecting what the user agent is able or willing to provide". Explicitly a *target*, observable only gradually via `jitterBufferDelay / jitterBufferEmittedCount`. Source: https://raw.githubusercontent.com/w3c/webrtc-pc/main/webrtc.html (`#rtcrtpreceiver-jitterbuffertarget`).

**Chrome:** shipped **M124**, enabled by default, desktop + Android + WebView + iOS. chromestatus feature 5930772496384000 (https://chromestatus.com/feature/5930772496384000), crbug https://issues.chromium.org/issues/324276557. (The Intent to Ship, https://groups.google.com/a/chromium.org/g/blink-dev/c/bReU8otUmdk, said M123; chromestatus records 124. M124 stable was 2024-04-16.)

**Implementation — and this is the important part.** `third_party/blink/renderer/modules/peerconnection/rtc_rtp_receiver.cc`:
```cpp
void RTCRtpReceiver::setJitterBufferTarget(std::optional<double> target, ExceptionState& es) {
  if (target.has_value() && (target.value() < 0.0 || target.value() > 4000.0)) {
    es.ThrowRangeError("jitterBufferTarget is out of expected range 0 to 4000 ms");
    return;
  }
  jitter_buffer_target_ = target;
  receiver_->SetJitterBufferMinimumDelay(target ? *target/1000.0 : std::nullopt);
}
```
`SetJitterBufferMinimumDelay` → libwebrtc `SetBaseMinimumPlayoutDelayMs` → `VideoReceiveStream2::base_minimum_playout_delay_`. **In Chrome it is a *minimum*, not a target.** `VCMTiming::TargetDelay() = max(min_playout_delay, jitter_delay + decode_time + render_delay)`. Setting it to 0 therefore does nothing to reduce latency below what the jitter estimator asks for. It can only raise the floor.

Chrome's non-standard `RTCRtpReceiver.playoutDelayHint` writes to the *same* backing call — last writer wins, and there is no arbitration between them.

**Interaction with playout-delay — `video/video_receive_stream2.cc::UpdatePlayoutDelays()`:**
```cpp
minimum_delay = max( frame_minimum_playout_delay_,      // from the RTP extension
                     base_minimum_playout_delay_,       // jitterBufferTarget / playoutDelayHint
                     syncable_minimum_playout_delay_ ); // A/V sync
// "When maximum delay is smaller than minimum delay, maximum delay takes priority.
//  It arrived with the frame, and thus is an explicit request to limit the delay."
if (frame_maximum_playout_delay_ && minimum_delay > *frame_maximum_playout_delay_)
    minimum_delay = *frame_maximum_playout_delay_;
```
**Your extension's `max` wins over the page's `jitterBufferTarget` and over A/V sync.** So a sender sending `min=0, max=100` cannot be overridden upward by the page. (It logs `"Maximum playout delay … overrides minimum delay"` and `"Multiple playout delays set"` warnings.)

**Safari:** implemented, contrary to what chromestatus says (it lists Safari as "no signal", pointing at the still-open https://github.com/WebKit/standards-positions/issues/317 — that entry is stale). WebKit `main`:
- `Source/WebCore/Modules/mediastream/RTCRtpReceiver.idl`: `attribute DOMHighResTimeStamp? jitterBufferTarget;`
- `RTCRtpReceiver.cpp::setJitterBufferTarget` — same `0 … 4000` RangeError.
- `Source/WebCore/Modules/mediastream/libwebrtc/LibWebRTCRtpReceiverBackend.cpp` → `m_rtcReceiver->SetJitterBufferMinimumDelay(ms/1000.0)` — same "minimum, not target" mapping as Chrome.

Firefox: shipped (https://bugzilla.mozilla.org/show_bug.cgi?id=1592988).

## 1.3 Everything else that matters on the receive side

**What Chrome offers for video, by default** — `media/engine/webrtc_video_engine.cc::WebRtcVideoEngine::GetRtpHeaderExtensions()`:

*Direction `kSendRecv`* (i.e. actually negotiated): `urn:ietf:params:rtp-hdrext:toffset`, `…/abs-send-time`, `urn:3gpp:video-orientation`, transport-cc (`draft-holmer-rmcat-transport-wide-cc-extensions-01`), **`…/playout-delay`**, **`…/video-content-type`**, **`…/video-timing`**, `…/color-space`, `…:sdes:mid`, rid, repaired-rid.

*Direction `kStopped`* (present in `getCapabilities()` but **not** offered and **not** echoed in an answer): corruption-detection, **`…/abs-capture-time`**, `…/generic-frame-descriptor-00` (unless field trial `WebRTC-GenericDescriptorAdvertised`), **dependency-descriptor** (unless `WebRTC-DependencyDescriptorAdvertised`), `…/video-layers-allocation00` (unless trial).

Important asymmetry I verified in `pc/media_session.cc`: the **answer** path uses `UnstoppedRtpHeaderExtensionCapabilities()` which hard-drops every `kStopped` capability. `UnstoppedOrPresentRtpHeaderExtensions()` — the one that keeps a stopped extension because the peer already used it — is only used in the **offer** path. **So offering abs-capture-time or the Dependency Descriptor to a default Chrome as the offerer gets you nothing in the answer.** The page can override this with `RTCRtpTransceiver.setHeaderExtensionsToNegotiate()`, shipped in **Chrome 117** (chromestatus 5680189201711104, "WebRTC RTP header extension control").

None of `WebRTC-DependencyDescriptorAdvertised`, `WebRTC-GenericDescriptorAdvertised`, `WebRTC-RtcpLossNotification` or `WebRTC-Video-H26xPacketBuffer` appear in Chromium's checked-in `fieldtrial_testing_config.json` today.

**`video-content-type` (screenshare hint):** URI `http://www.webrtc.org/experiments/rtp-hdrext/video-content-type`, 1 byte, and as of current code **only bit 0 is meaningful** (`*content_type = data[0] & 0x1`; 0 = unspecified, 1 = screenshare) — five formerly-defined bits are accepted but masked off. On the receive side it is parsed into `RTPVideoHeader.content_type` and then used **only for stats** (`VideoReceiveStream2::OnDecodedFrame` → `stats_proxy_`). I grepped `video_receive_stream2.cc`, `video_stream_buffer_controller.cc`, `timing/timing.cc` and `timing/jitter_estimator.cc`: **it does not change Chrome's jitter buffer, decode scheduling or render behaviour.** Don't use it as a latency lever. (It does matter on the *send* side, which is irrelevant to you.)

**`abs-capture-time`:** URI `http://www.webrtc.org/experiments/rtp-hdrext/abs-capture-time`, 8 or 16 bytes. Receive-side it feeds `AbsoluteCaptureTimeInterpolator` → `RtpPacketInfo` → `RTCRtpContributingSource.captureTimestamp` and A/V-sync estimation. No latency benefit, and it's `kStopped` by default.

**`video-timing`:** URI `http://www.webrtc.org/experiments/rtp-hdrext/video-timing`, 13 bytes, 6 × uint16 deltas + flags. Receive-side it populates `TimingFrameInfo` which surfaces only in `getStats()`. Useful for measurement, not for behaviour.

**`RTCRtpEncodingParameters`:** sender-side only. Nothing there affects a receiver.

---

# Q2 — What Chrome's H.265 receiver requires

## 2.1 Shipping status

- **chromestatus 5153479456456704** — "H265 (HEVC) codec support in WebRTC", status **"Enabled by default"**, desktop/Android/WebView **136**. Finch names `WebRtcAllowH265Send, WebRtcAllowH265Receive`. crbug https://issues.chromium.org/issues/391903235. Created 2025-02-28.
- **Intent to Ship**, Henrik Boström, **2025-03-03**: https://groups.google.com/a/chromium.org/g/blink-dev/c/3h8lL8a377c — *"H265 encoding is only available if the user's device and operating system provide the necessary capabilities as we will not provide a software implementation to fall back to."* Claimed HW coverage: Windows 75%, macOS 99%, Android 86%, iOS 90%.
- M136 schedule (chromiumdash): branch 2025-03-31, early stable 2025-04-23, late stable 2025-05-13.
- **Current default, verified today** — `media/webrtc/webrtc_features.cc`:
  ```cpp
  BASE_FEATURE(kWebRtcAllowH265Send,    base::FEATURE_ENABLED_BY_DEFAULT);
  BASE_FEATURE(kWebRtcAllowH265Receive, base::FEATURE_ENABLED_BY_DEFAULT);
  BASE_FEATURE(kWebRtcH265L1T2, base::FEATURE_DISABLED_BY_DEFAULT);  // send-side only
  BASE_FEATURE(kWebRtcH265L1T3, base::FEATURE_DISABLED_BY_DEFAULT);
  ```
- **`WebRTC-Video-H26xPacketBuffer` no longer gates H.265.** `video/rtp_video_stream_receiver2.cc`:
  ```cpp
  bool RtpVideoStreamReceiver2::UseH26xPacketBuffer(std::optional<VideoCodecType> codec) const {
    if (codec == kVideoCodecH265) return true;
    if (codec == kVideoCodecH264) return env_.field_trials().IsEnabled("WebRTC-Video-H26xPacketBuffer");
    return false;
  }
  ```
  History: the trial was launched for H.264 in M133, regressed streams with fragmented SEI NALs (https://issues.chromium.org/issues/402547556, filed by Phenix RTS, repro'd 133.0.6943.53 → Canary 136.0.7052.0), and was **reverted and un-launched for H.264 in M136** (https://webrtc-review.googlesource.com/c/src/+/380860 and /380861) while staying on for H.265 "because it does not work with the old packet buffer anyway". The proper depacketizer fix (CL 380821) was abandoned.

**Hardware-only, and what happens without HEVC HW decode:**
- `media/engine/internal_decoder_factory.cc::GetSupportedFormats()` returns VP8, VP9, H264, AV1 — **H.265 is not there and never will be**.
- `third_party/blink/renderer/platform/peerconnection/rtc_video_decoder_factory.cc` builds the H265 SDP entries **only** from `gpu_factories_->GetSupportedVideoDecoderConfigs()`, filtered to `HEVCPROFILE_MAIN` / `HEVCPROFILE_MAIN10`. `QueryCodecSupport()` returns `{false,false}` for HEVC when the feature is off.
- **No HW decode → H.265 is simply absent from the offer/answer.** No software fallback, no green frames, no failure mode to debug — negotiation just resolves to another codec (or fails if you're H.265-only).
- **On Windows the Microsoft Store "HEVC Video Extensions" package is not required for Chrome.** `media/gpu/windows/supported_profile_helpers.cc` queries `ID3D11VideoDevice1::GetVideoDecoderProfile` for `DXVA_ModeHEVC_VLD_Main`/`_Main10` directly (D3D11VA). **Edge does need it** (it uses the MediaFoundation VDA path) — and separately, Edge has **not** enabled `WebRtcAllowH265Send/Receive` at all (Microsoft answer thread, reported 2026-05-04, Edge 147; https://learn.microsoft.com/en-us/answers/questions/5880331/, tracked at MSEdgeExplainers #1273/#1314, unassigned). Edge announced it in their 136 notes in April 2025 and later removed the note. **If Edge is a target, you cannot use H.265 there.**
- One in-code quirk: `kMinHEVCResolutionForNvidia(144,144)` in the same file — below 144×144 NVIDIA reports no HW HEVC.
- Diagnostic: read `decoderImplementation` from `getStats()` / `chrome://webrtc-internals`. Since https://chromium-review.googlesource.com/c/chromium/src/+/7743360 (2026-04-14, M149) a post-creation HW failure correctly reports `"NullVideoDecoder (fallback from: …)"`; before that it lied.

## 2.2 SDP — exactly what Chrome emits and parses

**Chrome's offer** (`rtc_video_decoder_factory.cc::VdcToWebRtcFormat`, verbatim):
```cpp
webrtc::SdpVideoFormat format(webrtc::kH265CodecName);
format.parameters = {
    {webrtc::kH265FmtpProfileId, H265ProfileToString(ptl.profile)},   // "1" Main, "2" Main10
    {webrtc::kH265FmtpTierFlag,  H265TierToString(ptl.tier)},         // always "0"
    {webrtc::kH265FmtpLevelId,   H265LevelToString(ptl.level)},
    {webrtc::kH265FmtpTxMode,    "SRST"}};
```
i.e.
```
a=rtpmap:<pt> H265/90000
a=fmtp:<pt> level-id=<N>;profile-id=1;tier-flag=0;tx-mode=SRST
```
`level-id` is computed by `webrtc::GetSupportedH265Level(gpu_max_coded_size, 30 fps)` — **it varies per machine with the GPU's max decode resolution.** Observed `level-id=180` (Level 6) on Chrome 144 macOS arm64 (str0m issue #860). Two payload types are offered when the GPU supports both Main and Main10, each with its own `rtx`/`apt`. H.265 lives in the **lower dynamic PT range [35,65]** since https://webrtc-review.googlesource.com/c/src/+/376520 (2025-02-10).

**What Chrome parses** (`api/video_codecs/h265_profile_tier_level.cc`): `profile-id` (1–11), `tier-flag` (0/1), `level-id` (30/60/63/90/93/120/123/150/153/156/180/183/186). Defaults when absent: **Main / Tier 0 / Level 3.1 (`level-id=93`)**. Returns `nullopt` (→ no match) on an unparseable value, or on `level ≤ 3.1 && tier == 1`.

**Codec matching** (`media/base/codec_comparators.cc::IsSameCodecSpecific`):
```cpp
if (either_name_matches(kH265CodecName)) {
  return H265IsSameProfile(params1, params2) &&
         H265IsSameTier(params1, params2) &&
         IsSameH265TxMode(params1, params2);   // "SRST" inferred when absent
}
```
- **`level-id` is NOT compared.** Level asymmetry is allowed, per RFC 7798 §7.2.2.
- **Does Chrome require `tx-mode=SRST`?** No — it requires *equality after defaulting*. Omit `tx-mode` entirely, or send `tx-mode=SRST`; both match. `MRST`/`MRMT` = no match, and neither is implemented anyway.
- `profile-space`, `profile-compatibility-indicator`, `interop-constraints` exist as constants in `media/base/media_constants.cc` but are **not used in matching**.
- **`sprop-vps` / `sprop-sps` / `sprop-pps` / `sprop-max-don-diff`: not parsed, not required, and not rejected** — unknown fmtp keys are simply ignored by the H.265 comparator. But see 2.3: they're also useless, because Chrome has no out-of-band parameter-set path for H.265.

**Chrome's answer** (`pc/codec_vendor.cc`):
```cpp
if (absl::EqualsIgnoreCase(ours.name, kH265CodecName)) {
  H265GenerateProfileTierLevelForAnswer(ours.params, theirs->params, &negotiated.params);
  NegotiateTxMode(ours, *theirs, &negotiated);
}
```
`H265GenerateProfileTierLevelForAnswer` (`media/base/sdp_video_format_utils.cc`) sets **`level-id = min(local, remote)`** — so yes, Chrome includes level-id in the answer and **downgrades** it. It skips entirely (emits no PTL) only if *both* sides omitted all three of profile-id/tier-flag/level-id. `NegotiateTxMode` keeps `tx_mode` only when both sides agree.

Reference spec (matches Chrome's behaviour almost exactly): **draft-ietf-avtcore-hevc-webrtc-09**, "H.265 Profile for WebRTC", **2026-07-20, in WG Last Call** — https://datatracker.ietf.org/doc/draft-ietf-avtcore-hevc-webrtc/. Key normative text: MUST support Main Profile Level 3.1 (`level-id=93`), SHOULD support Level 4; `tx-mode` SHOULD be included, `SRST` inferred if absent, `SRST` MUST be supported; **"WebRTC implementations MUST signal [parameter sets] in-band… MUST NOT include these parameters in the SDP they generate, and SHOULD silently ignore these parameters if they are received"**; **"An IDR/CRA/BLA sent MUST always be preceded by the relevant parameter sets sent in a packet (not necessarily a separate packet) with the same RTP timestamp as the IDR/CRA/BLA"**; "VCL NAL units MUST NOT be aggregated with non-VCL NAL units with a lower TID value." Note Chrome emits `tx-mode` even though the draft says implementations SHOULD NOT include it — this has bitten at least two libraries (see 2.5).

## 2.3 Depacketizer and packet buffer — the hard requirements

**`modules/rtp_rtcp/source/video_rtp_depacketizer_h265.cc`:**
- **AP (type 48): supported.** `ParseApStartOffsets` walks `[16-bit length][NAL]` pairs after a 2-byte AP header.
- **FU (type 49): supported.** 2-byte PayloadHdr + 1-byte FU header; S bit reconstructs the original NAL header.
- **PACI (type 50): NOT implemented.** `RTC_LOG(LS_ERROR) << "Not support type:" << nal_type; return std::nullopt;` — the packet is discarded. `TODO(bugs.webrtc.org/13485)`, which now redirects to the H.265 umbrella bug https://issues.webrtc.org/issues/41480904, i.e. it is not separately tracked. **Do not send PACI.**
- A nested AP/FU/PACI *inside* an AP also returns `nullopt` ("Unexpected AP, FU or PACI received").
- **No DONL/DOND parsing anywhere.** Both the AP and FU paths assume the payload begins immediately after the fixed headers. **`sprop-max-don-diff` must be absent or 0, and you must never write DONL** — it will be misread as NAL length / NAL header and the packet will be dropped or produce garbage. (This is exactly the pion payloader bug, below.)
- Frame typing: IRAP = NAL types **16–21** (`BLA_W_LP`…`CRA`) → `kVideoFrameKey`; everything else → `kVideoFrameDelta`. Start codes are inserted by the depacketizer.
- `is_first_packet_in_frame` is set for NAL types **32–35** (VPS/SPS/PPS/AUD) and **39** (PREFIX_SEI), or for a VCL NAL whose `first_slice_segment_in_pic_flag == 1`.

**`modules/video_coding/h26x_packet_buffer.cc` — verified against CL 494740 (merged 2026-08-07), i.e. current:**

1. **VPS in the first packet of any new continuous run.**
   ```cpp
   bool H26xPacketBuffer::BeginningOfStream(const Packet& packet) const {
     if (packet.codec() == kVideoCodecH264) return HasSps(packet) || (idr_only_allowed && BeginningOfIdr(packet));
     else if (packet.codec() == kVideoCodecH265) return HasVps(packet);
   }
   ```
   Called from `FindFrames` whenever the inserted packet has no continuous predecessor. **No VPS in that packet → the buffer refuses to start, and nothing you send afterwards helps until another VPS-bearing packet arrives.**

2. **VPS + SPS + PPS in the same access unit as every IRAP.**
   ```cpp
   } else if (packet->codec() == kVideoCodecH265) {
     ... has_idr |= (nalu_type >= kBlaWLp && nalu_type <= kRsvIrapVcl23);
         has_vps |= nalu_type == kVps; has_sps |= ...; has_pps |= ...;
     if (has_idr) { if (!has_vps || !has_sps || !has_pps) return false; }
   }
   ```
   The scan runs over **all packets of the frame** (from the first packet after the previous RTP timestamp through the marker-bit packet) — so the parameter sets may be in separate packets or in an AP; they do **not** have to be in the same packet as the IDR slice. But they must be in the same access unit. On `return false`, `FindFrames` bails with "no subsequent frame will be continuous" — the keyframe is silently never delivered.

3. **No out-of-band parameter sets for H.265, at all.** In-code comment: *"Only applies to H.264 because start code is inserted by depacketizer for H.265 and out-of-band parameter sets is not supported by H.265."* `SetSpropParameterSets()` early-returns unless `h264_idr_only_keyframes_allowed_`. So the H.264 `sprop-parameter-sets` / `sps-pps-idr-in-keyframe` mechanisms have **no H.265 equivalent**.

4. **Framing is driven by the RTP marker bit.** `FindFrames` only attempts assembly when `packet->marker_bit` is set, then walks backwards to the first packet with a different RTP timestamp. **Set M only on the last packet of the last NAL of the access unit.** Setting it per-NAL costs you every slice/tile after the first.

**H.264, for contrast:** SPS+PPS are required inside the IDR frame **only** if the `sps-pps-idr-in-keyframe` fmtp param is present or the `WebRTC-SpsPpsIdrIsH264Keyframe` trial is on (`rtp_video_stream_receiver2.cc` line ~397). Otherwise IDR-only keyframes are allowed and `sprop-parameter-sets` is consumed into the SPS/PPS tracker.

## 2.4 NACK / RTX / RTCP feedback

`media/engine/webrtc_video_engine.cc::AddDefaultFeedbackParams` — for **every** video codec including H.265:
```
a=rtcp-fb:<pt> goog-remb
a=rtcp-fb:<pt> transport-cc
a=rtcp-fb:<pt> ccm fir
a=rtcp-fb:<pt> nack
a=rtcp-fb:<pt> nack pli
```
`goog-lntf` is added **only** when `codec->name == kVp8CodecName` **and** `trials.IsEnabled("WebRTC-RtcpLossNotification")`.

**RTX:** `GetPayloadTypesAndDefaultCodecs` adds an RTX codec for every non-FEC codec (the "VP8, VP9, AV1, H264, and RED" comment above `AddRtx` is stale — the code checks only `resiliency_type != kFlexfec && != kUlpfec`). So Chrome offers `a=rtpmap:<rtxpt> rtx/90000` + `a=fmtp:<rtxpt> apt=<h265pt>` for H.265. `rtx-time` defaults to `kNackHistoryMs = 1000`.

**Feedback params are intersected on negotiation** (`pc/codec_vendor.cc`: `negotiated.IntersectFeedbackParams(*theirs)`), so offering `goog-lntf` on an H.26x payload type to Chrome gets it dropped from the answer.

**Keyframe request cadence:** `video/video_receive_stream2.h` — `kMaxWaitForKeyFrame = 200 ms`, `kMaxWaitForFrame = 3 s`. With Chrome's default NACK history of 1000 ms, `DetermineMaxWaitForFrame` returns the constants (because `3 × 1000` is not `< 3000`), so **Chrome re-sends a PLI roughly every 200 ms while it has no keyframe.** On the sender side libwebrtc rate-limits keyframes to one per `kMinKeyframeSendIntervalMs = 300` (`video/encoder_rtcp_feedback.cc`, with the comment "Always produce key frame for all streams").

## 2.5 Known interop bugs (all URLs fetched and verified)

**Confirmed third-party-sender → Chrome failures:**

| # | What | Link, date, status |
|---|---|---|
| 1 | **ZLMediaKit: marker bit set on the last packet of *every* NALU** instead of the last NALU of the frame → Chrome assembles a "frame" containing only the first tile; multi-tile H.265 renders left half only, right half grey | https://github.com/ZLMediaKit/ZLMediaKit/issues/4696 (2026-03-23, closed 2026-03-25); PR #4699 merged 2026-04-01. **Caveat: maintainer `xia-chu` agreed on 2026-04-16 that the committed change was a no-op ("确实改了个寂寞") — treat the fix as unverified.** Same family: #4398 → PR #4402 (merged 2026-08-22) |
| 2 | **SEI NALs cause H.265 (and H.264) to show one frame then freeze** on Chrome 146 / Edge. Removing SEI from the source fixed it; workaround `rtsp.directProxy=0` | https://github.com/ZLMediaKit/ZLMediaKit/issues/4698 (2026-03-24, closed 2026-03-25). **Current, post-M136, mechanism unexplained by anything in the WebRTC source I read — worth an independent repro** |
| 3 | **SEI-only access units with their own RTP timestamp are dropped by Chrome, Firefox AND Safari** (DJI drone → mediamtx). Fix merges the SEI AU into the following picture | https://github.com/bluenviron/mediamtx/pull/6051 (2026-08-07, **still open**; maintainer review 2026-08-28) |
| 4 | **AWS Kinesis Video Streams WebRTC SDK-C: H.265 blank screen** until VPS/SPS/PPS were copied onto *every* keyframe | https://github.com/awslabs/amazon-kinesis-video-streams-webrtc-sdk-c/pull/2111 (2025-04-10, merged). Direct empirical confirmation of the VPS/SPS/PPS-per-IRAP rule |
| 5 | **str0m: Chrome's machine-dependent `level-id=180` broke strict fmtp matching** → H.265 dropped from the answer entirely. Verbatim Chrome 144 SDP: `a=fmtp:49 level-id=180;profile-id=1;tier-flag=0;tx-mode=SRST` | https://github.com/algesten/str0m/issues/860 (2026-02-08 → closed 2026-03-04); fix PR #872 "remove level rejection, narrow to min(local,remote)" |
| 6 | **Membrane: Chrome's `tx-mode=SRST` treated as a codec mismatch** by strict fmtp comparison; same PR fixed an FU fragmentation crash | https://github.com/membraneframework/membrane_webrtc_plugin/pull/45 (merged 2026-09-09); https://github.com/membraneframework/ex_sdp/pull/69 (2026-08-31, open) |
| 7 | **pion: H.265 payloader wrote DONL** (advancing it every FU, with no API to supply real values) → unplayable in Chrome. Depacketizer was also "mostly broken". | https://github.com/pion/webrtc/issues/3137 (2025-06-01 → 2026-01-04); https://github.com/pion/rtp/pull/348 (merged 2026-01-02, rewrite) and **#350 (merged 2026-01-04, "Fix H265Payloader", disables DONL)**. Shipped in `pion/rtp` v1.10.0 (2026-01-08); `pion/webrtc` v4.3.0 **has not shipped** (latest v4.2.20, 2026-09-04) |
| 8 | **OvenMediaEngine: incorrect DONL size check silently dropped valid FU packets** when `sprop-max-don-diff=0`; also now caches VPS/SPS/PPS arriving fragmented across FU | https://github.com/OvenMediaLabs/OvenMediaEngine/pull/2032 (2026-03-19, merged) |
| 9 | **str0m wired up `sprop-max-don-diff`/DONL end-to-end** (merged 2026-03-04, PR #885). **If you enable this toward Chrome you will break it.** | https://github.com/algesten/str0m/pull/885 |
| 10 | **SRS negotiates H.264 in SDP but sends H.265 RTP** → black video (SRT publisher, no `vcodec` param) | https://github.com/ossrs/srs/issues/4738 (2026-09-14, **open**), SRS 7.0.157 |
| 11 | libdatachannel H.265 sample failed against Chrome pre-M136; resolved by Chrome, not the library | https://github.com/paullouisageneau/libdatachannel/issues/1289 (2024-11-17 → 2024-11-20) |
| 12 | webrtc-rs "fix and verify H265 packetizer/depacketizer issue" — **no description, no usable root cause; do not cite as evidence of anything specific** | https://github.com/webrtc-rs/webrtc/issues/779 (2026-03-01, closed) |

**Chrome-side changes M136 → M155 that can break a previously-working sender** (all verified on chromium-review / webrtc-review):

- **M148, 2026-03-10** — https://chromium-review.googlesource.com/c/chromium/src/+/7644891 "Fail H.265 structural config changes on non-IRAP pictures". Resolution/profile/bit-depth changes outside an IRAP now **fail the decode** instead of being ignored.
- **M153, 2026-08-04** — https://chromium-review.googlesource.com/c/chromium/src/+/8176990 "Reject all non-IRAP H.265 SPS configuration changes" — extends the above to every SPS field.
- **M150–M153 (security, merged back), 2026-07-28** — https://chromium-review.googlesource.com/c/chromium/src/+/8160680 "Reject HEVC non-first slice segment when prior slice is missing" (https://issues.chromium.org/issues/536470854, driver OOB write). **Multi-slice / multi-tile senders now get a hard decode failure instead of partial output when the first slice segment of a picture is lost.** In every current stable.
- M148, 2026-03-17 — https://chromium-review.googlesource.com/c/chromium/src/+/7671861 "Reject H265 dependent slices across layer boundaries".
- M149, 2026-04-23 — https://chromium-review.googlesource.com/c/chromium/src/+/7788568 "Conditionally enforce strict HEVC coding block size limits".
- M155, 2026-09-09 — https://chromium-review.googlesource.com/c/chromium/src/+/8381616 "Fix HEVC PicOrderCntValList and POC map" — with 15 active references, `PicOrderCntValList[14]` was left 0 → wrong POC via TMVP on Windows DXVA. Latent mis-decode for streams with many reference pictures.
- **2026-09-02, webrtc CL 497280** — "Recover after large RTP sequence number discontinuity". I verified the commit message verbatim: ***"H.264 and H.265 are excluded. H26xPacketBuffer has no reset API, and H.264 keyframe classification can change in H264SpsPpsTracker."*** → **a sequence-number jump larger than half the 16-bit range can wedge an H.265 receive stream permanently.** Don't reuse an SSRC without resetting, and don't jump sequence numbers. https://webrtc-review.googlesource.com/c/src/+/497280
- 2026-08-07, CL 494740 — "Improve H26xPacketBuffer management in RtpVideoStreamReceiver2": fixes leaked keyframe config across codec changes, ignored PT parameter updates, and **buffer recreation mid-stream dropping packets**. Matters for renegotiation / PT changes.
- 2026-07-30, CL 492460 — "Fix potential OOB accesses in H26x parsers".
- 2026-09-09, CL 500602 — H.264 depacketizer now rejects STAP-A whose rewritten SPS exceeds 65535 bytes and validates SPS dimensions fit uint16.
- 2025-02-26, CL 378703 — "Support h265 streams with weighted prediction tables" — before this, such streams failed SPS parsing.

**Searches that came back empty (stated so you don't repeat them):** no confirmed "H.265 green frames" report specific to Chrome WebRTC receive; no `webrtcbin`/`rtph265pay` ↔ Chrome H.265 interop bug on gitlab.freedesktop.org; no discuss-webrtc H.265-receive-failure threads for 2025–2026; no new H.265 receive field trial after M136; no HEVC *decode* GPU blocklist/allowlist change on Windows in M136–M155; no Chromium/WebRTC bug describing an M137–M155 H.265 receive regression that broke previously-working senders.

**GStreamer note (documentation, not a bug):** `rtph265pay` needs `config-interval=-1` to send VPS/SPS/PPS with every IDR — effectively mandatory for Chrome — and `aggregate-mode=zero-latency` for WebRTC. https://gstreamer.freedesktop.org/documentation/rtp/rtph265pay.html

---

# Q3 — Safari

WebKit vendors libwebrtc at `Source/ThirdParty/libwebrtc/Source/webrtc/`, so most of Q2 transfers directly. I diffed the relevant files against upstream.

**HEVC history.** Safari shipped HEVC over WebRTC **before** it shipped RFC 7798. WebKit blog, *"WebKit Features in Safari 18.0"* (Safari 18.0 released **2024-09-16**): *"WebKit for Safari 18.0 adds support for the WebRTC HEVC RFC 7789 RTP Payload Format. Previously, the WebRTC HEVC used generic packetization instead of RFC 7789 packetization."* ("7789" is their typo for 7798.) https://webkit.org/blog/15865/webkit-features-in-safari-18-0/ — tracked as WebKit bug **258794** (https://bugs.webkit.org/show_bug.cgi?id=258794), commit https://github.com/WebKit/WebKit/commit/93eb48d39b70248c062e90fceb4630a312e46b0d. **So: Safari ≥ 18 = RFC 7798. Safari < 18 / older iOS = proprietary generic packetization you cannot interoperate with.**
Corroborating historical interop report: discuss-webrtc *"H265 RTP payload from Apple devices"* (Alex Pokotilo, **2022-07-05**, follow-up 2023-07) — Apple devices emitted Annex-B `00 00 00 01` start codes *inside* the RTP payload, violating RFC 7798; third-party receivers got "garbage in playback". https://groups.google.com/g/discuss-webrtc/c/Zc3-3hddEn0

**What Safari offers in SDP.** `Source/ThirdParty/libwebrtc/Source/webrtc/webkit_sdk/objc/components/video_codec/RTCDefaultVideoDecoderFactory.m`:
```objc
if (_supportsH265) {
  RTCVideoCodecInfo *h265Info = [[RTCVideoCodecInfo alloc] initWithName:kRTCVideoCodecH265Name];
  [codecs addObject:h265Info];
}
```
— **no fmtp parameters at all.** So Safari emits `a=rtpmap:<pt> H265/90000` and relies entirely on the defaults: `profile-id=1` (Main), `tier-flag=0`, `level-id=93` (Level 3.1), `tx-mode=SRST`. Contrast with H.264, where WebKit *does* set `profile-level-id`, `level-asymmetry-allowed=1`, `packetization-mode` 0 and 1.

**What Safari accepts.** WebKit's `media/base/codec_comparators.cc` gates the H.265 profile/tier/tx-mode check behind an extra build flag:
```cpp
#ifdef RTC_ENABLE_H265
#ifdef RTC_ENABLE_H265_TIGHT_CHECKS
  if (either_name_matches(cricket::kH265CodecName)) {
    return H265IsSameProfile(...) && H265IsSameTier(...) && IsSameH265TxMode(...);
  }
#endif
#endif
  return true;
```
**I could not determine whether WebKit's production build defines `RTC_ENABLE_H265_TIGHT_CHECKS`** (it is not in `Configurations/libwebrtc.xcconfig`, but I did not exhaust the build files). **Unverified.** If it is undefined, Safari matches *any* H.265 fmtp — which is permissive and harmless for you. Either way, offering `profile-id=1;tier-flag=0;tx-mode=SRST` (or omitting all of them) is safe for both browsers.

**Framing requirements: identical to Chrome.** I fetched WebKit's copies of `modules/video_coding/h26x_packet_buffer.cc` and `modules/rtp_rtcp/source/video_rtp_depacketizer_h265.cc` and they are byte-equivalent in the relevant logic:
- `BeginningOfStream()` → `HasVps(packet)` for H.265.
- `if (has_idr) { if (!has_vps || !has_sps || !has_pps) return false; }`.
- PACI → `"Not support type:"` → `nullopt`.
- No DONL parsing.
So the same sender rules apply to Safari, and mediamtx PR #6051 independently confirms Safari drops SEI-only access units too.

**playout-delay: yes.** WebKit's `WebRtcVideoEngine::GetRtpHeaderExtensions()` has the identical default list, with `…/playout-delay`, `…/video-content-type` and `…/video-timing` at `kSendRecv` and abs-capture-time / DD / generic-frame-descriptor at `kStopped`. So `playout-delay` negotiates with Safari by default and drives the same `UseLowLatencyRendering()` logic.

**jitterBufferTarget: yes** (see 1.2) — IDL, 0–4000 RangeError, and the same `SetJitterBufferMinimumDelay` mapping.

**HEVC is VideoToolbox-only**, gated on `LibWebRTCProviderCocoa::isSupportingH265()` → `createWebKitDecoderFactory(WebKitH265::On/Off, …)` → `RTCVideoDecoderH265` / `setHVCCFormat:`. No software fallback, same as Chrome.

---

# Q4 — Keyframe-free loss recovery

## 4.1 LNTF (`goog-lntf`) — effectively unusable for H.264/H.265

- **Constant:** `media/base/media_constants.cc`: `const char kRtcpFbParamLntf[] = "goog-lntf";` RTCP packet type: `modules/rtp_rtcp/source/rtcp_packet/loss_notification.h` (exists).
- **Negotiation is codec-gated:** `AddDefaultFeedbackParams` adds it **only** for `kVp8CodecName` **and** only when field trial `WebRTC-RtcpLossNotification` is enabled. Not in Chromium's checked-in field-trial testing config → off by default in Chrome. And because feedback params are *intersected* at negotiation, offering it on an H.26x PT is dropped.
- **Even if negotiated, the receiver needs the Dependency Descriptor.** `video/rtp_video_stream_receiver2.cc`:
  ```
  RTC_LOG(LS_WARNING) << "LossNotificationController requires generic frame descriptor, but it is missing.";
  ```
  `LossNotificationController::FrameDetails` is `{ is_keyframe, frame_id, frame_dependencies }` — it is a dependency-graph mechanism, not an RTP-sequence one. It also bails on reordered packets and on FEC-recovered packets (`"LossNotificationController does not support reordering."`).
- **Does Chrome SEND loss notifications to a remote sender?** Yes, mechanically — `RtpVideoStreamReceiver2::SendLossNotification` → `rtp_rtcp_->SendLossNotification(last_decoded_seq_num, last_received_seq_num, decodability_flag, buffering_allowed)`, with compound-packet buffering when a NACK or keyframe request is also pending. But only if `config_.rtp.lntf.enabled` (which comes from the negotiated `goog-lntf`) **and** the stream carries a generic frame descriptor. So: not for H.264/H.265 in any default configuration.
- Sender-side, libwebrtc implements `OnLossNotification` only on the VP8 path (`LibvpxVp8Encoder` → `Vp8FrameBufferController`); tracking bug https://issues.webrtc.org/issues/42220722 ("Experiment with LNTF messages in VP8") suggests the experiment was never finished.
- IETF status: **draft-majali-avtcore-lntf-feedback-message-00**, S. Majali (NVIDIA), **2024-06-03**, Experimental, **expired 2024-12-05**. Individual submission, never adopted by AVTCORE. https://datatracker.ietf.org/doc/draft-majali-avtcore-lntf-feedback-message/

## 4.2 RPSI — not implemented anywhere in libwebrtc

- No `modules/rtp_rtcp/source/rtcp_packet/rpsi.h` (404 on the mirror; `pli.h` and `loss_notification.h` are both present). Gerrit `q=file:rpsi` returns **zero** merged CLs. `media/base/codec.h` mentions `"rpsi"` only inside a comment listing example feedback param names. Same for SLI.
- This is despite **draft-ietf-avtcore-hevc-webrtc-09 §2.2** actually specifying RPSI for HEVC: *"Implementations MUST use the RPSI feedback message only as a reference picture selection request, and MUST NOT use it as positive acknowledgement"* and *"Receivers that detect encoder-decoder synchronization loss SHOULD generate an RPSI feedback message if negotiated support exists."* No browser implements it.
- Bernard Aboba, on the record, https://github.com/w3c/webcodecs/issues/743 (comment **2024-09-13**): *"It turns out that the RTCP RPSI message does not provide sufficient information for the SFM to make the decision (it's only useful for the 1-1 case), so implementations have created proprietary RTCP messages (e.g. LTN for libwebrtc, a PLI extension for Teams, etc.)."* — i.e. LTR-based recovery over WebRTC exists only as vendor-proprietary signalling.

## 4.3 Dependency Descriptor — the one genuinely interesting option

**The receive machinery is codec-agnostic.** I verified this in two places:
- `video/rtp_video_stream_receiver2.cc::ParseGenericDependenciesExtension` runs on **every** packet, before any codec-specific handling, and populates `RTPVideoHeader.generic` (frame_id, dependencies, decode_target_indications, spatial/temporal index, resolution) from either `RtpDependencyDescriptorExtension` or `RtpGenericFrameDescriptorExtension00`.
- `modules/video_coding/rtp_frame_reference_finder.cc::ManageFrame`:
  ```cpp
  if (video_header.generic.has_value()) {
    return GetRefFinderAs<RtpGenericFrameRefFinder>().ManageFrame(std::move(frame), *video_header.generic);
  }
  switch (frame->codec_type()) { case kVideoCodecVP8: ... }
  ```
  The generic path short-circuits the codec switch. **So DD frame dependencies would apply to H.264 and H.265 in Chrome's frame buffer.**

**But three blockers:**
1. **Chrome does not negotiate DD by default.** `kDependencyDescriptorUri` is `kStopped` unless `WebRTC-DependencyDescriptorAdvertised` is enabled, and Chrome's **answer** path drops `kStopped` capabilities outright (`pc/media_session.cc` → `UnstoppedRtpHeaderExtensionCapabilities`). Offering DD from your side as the offerer therefore gets you nothing back. **Workaround the page can apply: `transceiver.setHeaderExtensionsToNegotiate()` (Chrome 117+, chromestatus 5680189201711104) to flip `…#dependency-descriptor-rtp-header-extension` to `sendrecv`/`recvonly`.** Same for `generic-frame-descriptor-00` (`WebRTC-GenericDescriptorAdvertised`).
2. **For H.265 the `H26xPacketBuffer` still applies regardless.** DD does not bypass the VPS/SPS/PPS-per-IRAP rule, the VPS-at-stream-start rule, or marker-bit framing — DD affects the *reference finder*, which runs after frame assembly.
3. **The decoder still needs a real IRAP to start.** DD's decode-target-indications change which frames are considered decodable; they do not let VideoToolbox / DXVA start from a non-IRAP.

I have **not tested** whether DD-over-H.265 actually works end-to-end in Chrome. The code says it should; that's a hypothesis worth an experiment, not a fact.

## 4.4 Frame marking (draft-ietf-avtext-framemarking) — not implemented

No URI constant, no parser, no mention anywhere in `api/rtp_parameters.h`, `api/rtp_parameters.cc` or `media/base/media_constants.cc`. Google shipped the Dependency Descriptor instead. The draft itself never reached RFC.

## 4.5 Intra-refresh into a browser: it does not work, and here is why

Chain of causes, each verifiable in source:
1. `video/video_receive_stream2.h`: `keyframe_required_` starts `true` and only clears after a successful keyframe decode.
2. `video/video_stream_buffer_controller.cc`: `if (keyframe_required_) return ForceKeyFrameReleaseImmediately();` — it walks the buffer looking only for `is_keyframe()` frames.
3. **`modules/rtp_rtcp/source/video_rtp_depacketizer_h264.cc` marks `kVideoFrameKey` only for `NaluType::kSps` and `NaluType::kIdr`**; `kSlice` (which is what intra-refresh rows are) always yields `kVideoFrameDelta`. In the FU-A path: `if (original_nal_type == kIdr) key; else delta;`. **H.265** is the same: only NAL types 16–21 (IRAP) produce `kVideoFrameKey`. A recovery-point SEI is never parsed for frame typing.
4. `kMaxWaitForKeyFrame = 200 ms` → `HandleFrameBufferTimeout` → `RequestKeyFrame()` → PLI, forever.
5. Sender side, `video/encoder_rtcp_feedback.cc::OnReceivedIntraFrameRequest` answers any PLI/FIR with a full keyframe, rate-limited to one per 300 ms.

Corroboration: Selkies' own encoder issue annotates intra refresh as *"(was not compatible in WebRTC with x264, need to revisit)"* and Force IDR as *"(implemented using WebRTC PLI)"* — https://github.com/selkies-project/selkies/issues/34 (2022-04-22). discuss-webrtc https://groups.google.com/g/discuss-webrtc/c/rLnsr1dKLGE (2022-04-05): *"missing IDRs certainly do — you cannot start decoding a stream without an IDR."*

**WebCodecs is the escape hatch, and it's the only documented one.** `VideoDecoder` has `[[key chunk required]]`, set true at `configure()`/`flush()`/`reset()` — so it also needs a key chunk to *start* — but it imposes no per-frame reference model afterwards and, crucially, it is fed by *your* transport, so you can carry your own per-frame loss report. https://www.w3.org/TR/webcodecs/ · LTR control for AVC/HEVC in WebCodecs is **still an open request**: https://github.com/w3c/webcodecs/issues/743 (opened 2023-11-09).

## 4.6 What cloud-gaming stacks actually publish

**The single best citation** is NVIDIA's own framing of the tradeoff, NVENC Video Encoder API Programming Guide, Video Codec SDK 13.0 — https://docs.nvidia.com/video-technologies/video-codec-sdk/13.0/nvenc-video-encoder-api-prog-guide/index.html — reference picture invalidation *"depends upon availability of an out-of-band upstream channel to report bitstream errors at the decoder (client side). When such an upstream channel is not available, or in situations where bitstream is more likely to suffer from more frequent errors, intra-refresh mechanism can be used."* Relevant symbols: `NvEncInvalidateRefFrames` (keyed on `inputTimeStamp`), `NV_ENC_CAPS_SUPPORT_REF_PIC_INVALIDATION`; `enableIntraRefresh`/`intraRefreshPeriod`/`intraRefreshCnt` (requires `gopLength = NVENC_INFINITE_GOPLENGTH`); `enableLTR`/`ltrNumFrames`/`ltrTrustMode`/`ltrMarkFrame`/`ltrUseFrames` (no LTR with B-frames); `NV_ENC_PIC_FLAG_FORCEINTRA` / `FORCEIDR` / `OUTPUT_SPSPPS`.

**Moonlight/Sunshine is the only open ecosystem that ships this end-to-end — and it does not use a browser.**
- RFI design, verbatim from Cameron Gutman (Moonlight lead): https://github.com/games-on-whales/wolf/issues/5 (2022-11-05) — includes "speculative RFI" (firing the request before the frame even completes, recovering in one frame instead of ≥2). Wire format `SS_RFI_REQUEST_PTYPE 0x0301 {firstFrameIndex, lastFrameIndex}` in `moonlight-common-c/src/Video.h`. Host side `nvenc_base::invalidate_ref_frames()` in Sunshine, falling back to IDR when the request spans ≥ DPB size.
- **LTR + client ACKs superseded RFI, merged 2026-01-21**: https://github.com/moonlight-stream/moonlight-common-c/pull/122, design discussion https://github.com/moonlight-stream/moonlight-common-c/issues/120 (2025-12-25). Rationale: AV1's 8-frame DPB and long-RTT streams push all non-invalidated frames out of the DPB before the RFI lands; *"H.264, HEVC and AV1 codecs all support LTR frames. So do NVENC, VPL and AMF encoders. And AMF in particular is unable to do our existing RFI due to API limitations."* With ACKs, *"the no-IDR duration will become virtually infinite."*
- Gutman on intra-refresh, verbatim, 2024-10-24: *"Intra-refresh isn't relevant for us because we do not request periodic intra frames. We only request a key frame when a frame is lost, and we do really need the full key frame at that point rather than a slice of intra-coded blocks."* https://github.com/LizardByte/Sunshine/issues/3323 (closed *not planned*). Sunshine did later ship NVENC intra-refresh (https://github.com/LizardByte/Sunshine/pull/5091, merged **2026-05-10**, `intraRefreshPeriod=300`, `intraRefreshCnt=299`, `outputRecoveryPointSEI=1`) but it is **off by default** — gated on an RTSP attribute `x-ss-video[0].intraRefresh` that mainline `moonlight-common-c` never sends.
- **No browser client:** https://github.com/moonlight-stream/moonlight-docs/wiki/Frequently-Asked-Questions#is-there-a-moonlight-web-client — *"The GameStream protocol requires us to use raw TCP and UDP sockets which is not currently supported in web browsers."*

**Parsec: their browser client is not WebRTC media.** https://parsec.app/blog/game-streaming-tech-in-the-browser-with-parsec-5b70d0f359bc (**2018-10-15**) — video arrives over a **WebRTC DataChannel** as fragmented MP4 and plays through **Media Source Extensions** in Chrome's low-delay mode. **Parsec has never publicly documented its loss-recovery mechanism** (RFI vs LTR vs IDR) — I checked the blog index, the support KB and the Wikipedia article. Their protocol post (https://parsec.app/blog/a-networking-protocol-built-for-the-lowest-latency-interactive-game-streaming-1fd5a03a6007) only says they rejected WebRTC transport and adapt bitrate.

**Selkies / pixelflux is the most useful open data point,** and it went the same way as Parsec: away from WebRTC. Their design page (https://selkies-project.github.io/selkies/design/) has frames going over a **WebSocket**, decoded with **WebCodecs**; WebRTC is opt-in. https://github.com/selkies-project/pixelflux/issues/29 (**2026-09-16**) has measured RFI numbers — 24 s of server stalls at 1280×720/40 Mbit/s: **286 drops / 49 keyframes without RFI vs 266 drops / 0 keyframes with it** — plus the real blocker for everyone else: *"libavcodec… exposes no per-frame reference control"* (they link libx264 directly to get around it). **That combination — your own transport + WebCodecs — is the only publicly documented way to get reference-frame invalidation working with a browser receiver.**

**Everyone else: negative results.** Xbox Cloud Gaming's only public sentence is *"Utilizing WebRTC has significantly reduced latency while enhancing resilience through improved packet-loss management"* (GDC 2025, https://developer.microsoft.com/en-us/games/articles/2025/03/gdc-2025-xbox-cloud-gaming-beta-expanding-your-reach-enhancing-your-game/, 2025-03-21) — no codec, no keyframe policy. **Amazon Luna:** nothing (closest is Amazon GameLift Streams docs confirming browser + WebRTC + mandatory H.264). **Stadia:** press coverage of the GDC 2019 talk only (WebRTC with buffering disabled, VP9, BBR-derived CC) — no error-resilience post-mortem, and since its receiver was Chrome's own stack, everything in §4.5 applied to it. **Shadow, Netflix:** nothing.

**Other encoder APIs, for completeness:** Intel VPL `mfxExtAVCRefListCtrl::RejectedRefList` / `LongTermRefList` and `mfxExtCodingOption2::IntRefType`/`IntRefCycleSize` (https://intel.github.io/libvpl/latest/API_ref/VPL_structs_encode.html). AMD AMF has LTR (`AMF_VIDEO_ENCODER_MAX_LTR_FRAMES` 0–2, `MARK_CURRENT_WITH_LTR_INDEX`, `FORCE_LTR_REFERENCE_BITFIELD`) and intra-refresh (`INTRA_REFRESH_NUM_MBS_PER_SLOT`, default 255 in the low-latency presets), mutually exclusive, and **no reference-invalidation API** (https://github.com/GPUOpen-LibrariesAndSDKs/AMF/blob/master/amf/doc/AMF_Video_Encode_API.md). Apple VideoToolbox has ACK-based LTR (`kVTCompressionPropertyKey_EnableLTR`, `kVTEncodeFrameOptionKey_ForceLTRRefresh`, `kVTSampleAttachmentKey_RequireLTRAcknowledgementToken`, `kVTEncodeFrameOptionKey_AcknowledgedLTRTokens`) and **no intra-refresh property**. (`kVTCompressionPropertyKey_MaxAllowedFrameQP` is rate control — do not cite it for loss recovery.)

---

# Practical sender checklist

**Latency**
1. Send `playout-delay` with **`min=0`, `max=100 ms`** (anything 10–500 ms). Avoid `max=0` unless you deliberately want stale-frame dropping and the PLI storm that follows on a non-scalable codec.
2. Send it on the first packet of each frame until the receiver's highest-seen sequence number confirms delivery, then you may stop (per the WebRTC doc). Cheap enough to just always send.
3. Don't bother with `video-content-type` for latency — it's stats-only on receive.
4. Expect the page's `jitterBufferTarget` to be overridden by your `max`. That is by design in `UpdatePlayoutDelays()`.

**H.265 framing**
5. VPS + SPS + PPS **in-band, in every IRAP access unit** (same RTP timestamp run). No exceptions, no fmtp opt-out.
6. The first packet of any new coded video sequence must contain a **VPS**.
7. RTP **marker bit only on the last packet of the last NAL of the access unit**.
8. **No DONL, no PACI.** Omit `sprop-max-don-diff` or set it 0.
9. Don't emit SEI-only access units with their own RTP timestamp — merge them into the following picture.
10. Don't change SPS/resolution/profile outside an IRAP (M148+ hard-fails).
11. Don't jump RTP sequence numbers by more than half the 16-bit range — H.265 has no recovery path (CL 497280).

**SDP**
12. Offer `a=fmtp: profile-id=1;tier-flag=0;tx-mode=SRST` plus a `level-id` you can actually decode/encode; treat the peer's `level-id` and `tx-mode` as **non-identifying** in your own matcher (this is what broke str0m and Membrane).
13. Offer `rtx`/`apt` for the H.265 PT, and `nack`, `nack pli`, `ccm fir`, `transport-cc`, `goog-remb`. Don't bother offering `goog-lntf` — Chrome intersects it away.
14. Expect a PLI roughly every 200 ms while Chrome has no keyframe; rate-limit your IDR generation accordingly (libwebrtc's own limit is 300 ms).

**If you want to experiment with keyframe-free recovery**
15. The only lever with a plausible path is the **Dependency Descriptor**, negotiated from the page via `setHeaderExtensionsToNegotiate()` (Chrome 117+). Chrome's DD receive path is codec-agnostic. Untested for H.26x; the H.265 packet-buffer rules still apply; and it still won't let a decoder start without an IRAP. Everything else (LNTF, RPSI, frame marking, intra-refresh-only) is a dead end in browsers today.

---

## Flagged as unverified
- Whether WebKit's production build defines `RTC_ENABLE_H265_TIGHT_CHECKS` (determines whether Safari does strict H.265 fmtp matching at all).
- Whether Chrome's *server-side* Finch config matches the checked-in `fieldtrial_testing_config.json` for `WebRTC-ZeroPlayoutDelay` (`min_pacing:0ms`) — and what happens to that override once the field trial's upstream removal (2026-08-13) rolls into Chrome.
- Whether the Dependency Descriptor actually works end-to-end with H.264/H.265 in Chrome once force-negotiated. Code says yes; not tested.
- ZLMediaKit #4698 (SEI → H.265 freeze on Chrome 146, post-M136): the symptom is confirmed and reproduced by the reporter, but nothing in the current WebRTC source explains it. Worth an independent repro before designing around it.
- ZLMediaKit PR #4699's marker-bit fix was called a no-op by the maintainer; the underlying bug report is still valid, the fix is not.
- Chrome also queries MediaFoundation HEVC capabilities on Windows (`Media.MediaFoundationPackageDecoder.HEVC` UMAs, added M147). That is believed to be the protected-content/MF-renderer path, not the D3D11 WebRTC decode path, but not every Windows decoder-selection branch was traced.
- My libwebrtc reading is from the 2026-01-13 mirror + Gerrit for later CLs; I re-verified `timing.cc`, `frame_decode_timing.cc`, `h26x_packet_buffer.cc` and `rtp_video_stream_receiver2.cc` at their latest merged CLs, but I did not re-verify every file that way.