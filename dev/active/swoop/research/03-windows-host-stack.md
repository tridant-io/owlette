# Swoop — Windows Host Stack Research

Research date: 2026-09-17. Target: `swoop-host`, a native Windows host for a Parsec-class
low-latency remote desktop, launched and supervised by an existing Windows service
(Python service inside a small Rust service wrapper). Fleet: Windows 10/11, TouchDesigner
installs, signage, kiosks, media servers. NVIDIA common, Intel iGPU / AMD sometimes, often
headless, sometimes giant multi-output canvases.

Every claim below is tagged `[verified: <source>]` (I read it in a primary/secondary source
cited inline) or `[inference]` (my reasoning from the verified facts).

---

## 1. CAPTURE

### 1.1 DXGI Desktop Duplication (DDA)

The API is `IDXGIOutput1::DuplicateOutput` / `IDXGIOutput5::DuplicateOutput1`, driven by
`IDXGIOutputDuplication::AcquireNextFrame`.

- **Format**: with `DuplicateOutput`, the desktop image is *always*
  `DXGI_FORMAT_B8G8R8A8_UNORM` regardless of the display mode
  [verified: https://learn.microsoft.com/en-us/windows/win32/direct3ddxgi/desktop-dup-api, page ms.date 2018-05-31, updated 2025-04-15].
  `DuplicateOutput1` lets you request a format list, which is how you get
  `R16G16B16A16_FLOAT` (scRGB HDR) or `R10G10B10A2_UNORM` (HDR10/Auto-HDR) on HDR desktops
  [verified: https://learn.microsoft.com/en-us/answers/questions/1457052/using-the-desktop-duplication-api-with-hdr-interpr ; corroborated by the winhdrshot/dxgi capture projects, https://pypi.org/project/winhdrshot/].
- **Dirty rects / move rects**: `GetFrameDirtyRects` returns non-overlapping rectangles
  updated since the last processed frame; `GetFrameMoveRects` returns
  destination-rect + source-point pairs for regions the OS *moved* (scrolling). You must
  process **all move rects before all dirty rects**. If the OS runs out of metadata space it
  coalesces regions into larger ones — still correct, just less precise
  [verified: same Microsoft Learn page]. This is a real bandwidth/encoder win for signage and
  kiosk content (mostly static screens) and **WGC does not offer it**.
- **Cursor**: `DXGI_OUTDUPL_FRAME_INFO.PointerPosition` tells you position + visibility;
  `GetFramePointerShape` gives the shape and hotspot, and only needs re-calling when the shape
  changes. If the adapter overlays the pointer in hardware, DDA reports "separate pointer
  visible" and the desktop image does *not* contain the cursor — the client must composite it.
  `LastMouseUpdateTime == 0` means no pointer update this frame
  [verified: same Microsoft Learn page]. This maps *exactly* onto the requested out-of-band
  cursor channel: send shape (as PNG/ARGB blob) on change + position every frame over a
  DataChannel, render it in the browser with a CSS cursor or canvas overlay [inference].
- **Rotation**: on a rotated display the returned surface is un-rotated (a 768x1024 portrait
  mode yields a 1024x768 surface with the image rotated inside it). You must rotate yourself.
  Per-monitor rotation is independent [verified: same page].
- **Multi-monitor**: one duplication object **per `IDXGIOutput`**. There is no "whole virtual
  desktop" duplication. For a giant multi-output canvas you must run N duplications and
  stitch, or encode N streams [verified: same page + the per-output design of the API].
- **Cross-GPU**: DDA requires the capturing D3D device to be on the *same adapter* as the
  display output; OBS documents that DXGI display capture requires OBS to run on the same GPU
  as the display, while WGC works cross-GPU with no user intervention
  [verified: https://obsproject.com/forum/threads/windows-graphics-capture-vs-dxgi-desktop-duplication.149320/]. Material for hybrid laptops and multi-GPU media servers.
- **`DXGI_ERROR_ACCESS_LOST`**: raised on desktop switch (UAC/secure desktop), mode change,
  DWM on/off, fullscreen-exclusive transitions, session disconnect/reconnect. The app must
  release the duplication interface and recreate it
  [verified: https://learn.microsoft.com/en-us/windows/win32/direct3ddxgi/desktop-dup-api and the MS classic sample https://github.com/microsoft/Windows-classic-samples/blob/main/Samples/DXGIDesktopDuplication/cpp/DesktopDuplication.cpp].
  **This is the single most common source of black screens in every product in this space.**
- **`DXGI_ERROR_WAIT_TIMEOUT`**: returned when nothing changed. Not an error — it is how you
  get "no new frame", and it is the mechanism you use to avoid re-encoding a static signage
  screen [verified: same page/sample].

### 1.2 Windows.Graphics.Capture (WGC)

WinRT API, Windows 10 1803+. `GraphicsCaptureItem` → `Direct3D11CaptureFramePool` →
`GraphicsCaptureSession`; frames arrive via `FrameArrived` with `SystemRelativeTime` stamped
in QPC units [verified: https://learn.microsoft.com/en-us/windows/apps/develop/media-authoring-processing/screen-capture, ms.date 2026-08-23].

- **Picker**: the documented consumer path uses `GraphicsCapturePicker` (secure system UI).
  For unattended fleet capture you must use the interop
  (`IGraphicsCaptureItemInterop::CreateForMonitor` / `CreateForWindow`) to build a
  `GraphicsCaptureItem` from an HMONITOR/HWND with no user interaction — that is what
  OBS/Sunshine do. Note MS's page only documents the picker path; the interop path is
  undocumented-but-stable and used by every capture product
  [verified: Sunshine `display_wgc.cpp` includes `Windows.Graphics.Capture.Interop.h`,
  https://docs.lizardbyte.dev/projects/sunshine/latest/display__wgc_8cpp.html] [inference for "no user interaction"].
- **Yellow border**: the system draws a yellow notification border around every actively
  captured item, one per session [verified: MS screen-capture page, 2026-08-23]. To suppress
  it, `GraphicsCaptureSession.IsBorderRequired = false`, but **the app must first obtain user
  consent via `GraphicsCaptureAccess.RequestAccessAsync(GraphicsCaptureAccessKind.Borderless)`,
  which shows a prompt, and must declare the `graphicsCaptureWithoutBorder` capability in an
  app package manifest.** If consent is denied the setter succeeds but is ignored. If *any
  other* app on the box sets `IsBorderRequired = true` for the same item, the border is drawn
  anyway. Requires Windows 10 build 20348+ / UniversalApiContract v12
  [verified: https://learn.microsoft.com/en-us/uwp/api/windows.graphics.capture.graphicscapturesession.isborderrequired, updated 2026-07-23].
  **This is a hard blocker for an unattended signage host**: it needs a packaged identity and
  a consent prompt nobody is there to click [inference]. Practical consequence: on WGC the
  fleet either lives with a yellow border, or you package the host with a sparse MSIX identity
  and pre-grant the capability — needs validation.
- **Cursor**: `GraphicsCaptureSession.IsCursorCaptureEnabled` (Windows 10 2004 / build
  19041+) toggles whether the cursor is burned into the frame
  [verified: https://learn.microsoft.com/en-us/uwp/api/windows.graphics.capture.graphicscapturesession.iscursorcaptureenabled?view=winrt-19041].
  Unlike DDA there is **no cursor shape/hotspot API** — you either get it burned in or not at
  all, so out-of-band cursor on WGC means calling `GetCursorInfo`/`GetIconInfo` yourself
  [inference].
- **Other knobs**: `MinUpdateInterval` (IGraphicsCaptureSession5) and
  `IncludeSecondaryWindows` (IGraphicsCaptureSession6) exist on newer builds
  [verified: https://pkg.go.dev/github.com/deploymenttheory/go-bindings-winrt/bindings/winrt/graphics/capture].
  `MinUpdateInterval` is useful to cap capture rate on a signage box.
- **No dirty rects.** WGC hands you a whole surface per frame; `ContentSize` tells you the
  valid sub-rect. Nothing equivalent to `GetFrameDirtyRects`
  [verified: MS screen-capture page describes only ContentSize/Surface/SystemRelativeTime; no dirty-rect surface exists in the namespace].
- **HDR**: MS explicitly says on Windows HD-color systems the content format may not be
  `B8G8R8A8_UNORM` and recommends `R16G16B16A16_FLOAT` end to end, with tone mapping as needed
  [verified: MS screen-capture page, 2026-08-23].
- **Cross-GPU**: works without user intervention, unlike DDA
  [verified: OBS forum thread above].
- **Latency**: WGC has "slightly more overhead than DXGI (usually negligible)" per the
  community comparison; it is a DWM-mediated path rather than a direct scanout duplication
  [verified: https://sageinfinity.github.io/docs/FAQ/dxgiwgc]. I could not find a rigorous
  published latency benchmark of WGC vs DDA. **[UNVERIFIED — measure it yourself.]**

### 1.3 Fullscreen-exclusive / independent flip / MPO / VRR

- Even with MPO disabled, DWM still uses independent flip when there is nothing to composite
  on top, which is what breaks capture pipelines
  [verified: https://forums.blurbusters.com/ discussion cited in search; corroborated by
  https://github.com/fernandoenzo/ForceComposedFlip].
- **Windows 11 24H2 changed the balance.** The Lossless Scaling maintainers state that as of
  24H2 "DXGI is no longer a reliable capture method unless Microsoft changes its approach or
  Nvidia and AMD improve MPO support"; without MPO, DXGI cannot distinguish game-window
  updates from overlay updates, which breaks frame pacing. Their recommendation is WGC
  [verified: https://sageinfinity.github.io/docs/FAQ/dxgiwgc and
  https://losslessscaling.com/resolution-scale-sgsr-v1-and-windows-11-24h2-compatibility/, Nov 2024].
- Sunshine has a live 24H2 black-screen issue where users report black frames even when
  forcing WGC [verified: https://github.com/LizardByte/Sunshine/issues/3995, open as of 2025].
- DXGI captures the pre-frame-generation frames; WGC captures the post-DWM composition, which
  is why DLSS-FG frames only appear under WGC
  [verified: https://github.com/fernandoenzo/ForceComposedFlip].
- WGC with the cursor enabled **disables independent flip globally**, adding latency to the
  app being captured and interfering with FreeSync
  [verified: Blur Busters thread cited in search results]. Relevant: a TouchDesigner output
  on a VRR panel may get slower while someone is remoted in [inference].

**Conclusion for Swoop**: you need *both*, selected at runtime, exactly like Sunshine. DDA is
the low-overhead, dirty-rect-bearing, same-GPU path; WGC is the compatibility path
(cross-GPU, 24H2, independent-flip content) [inference]. Sunshine ships DDA, WGC, and an AMD
display-capture path and picks among them
[verified: https://deepwiki.com/LizardByte/Sunshine/5.3-platform-specific-capture-implementations].

### 1.4 Secure desktop (Winlogon / UAC), session 0, lock screen

The facts that matter:

- Windows has **three desktops** on `WinSta0`: `Default`, `Winlogon` (the secure desktop used
  by the logon UI, Ctrl+Alt+Del, and by UAC prompts when "secure desktop" is on), and
  `ScreenSaver` [verified: https://en.wikipedia.org/wiki/Winlogon].
- **Session 0 isolation**: services run in session 0 with no interactive desktop. Interactive
  Services Detection (UI0Detect) was removed in Windows 10 1803; you can no longer switch to
  session 0, and SCM no longer grants interactive desktop rights
  [verified: https://learn.microsoft.com/en-us/answers/questions/27517/is-there-any-workaround-in-win10-to-allow-service].
- **WGC cannot be used from a service.** Sunshine issue #2846 (opened 2024-07-13) reports
  `failed to acquire device: [0x80070424]` (ERROR_SERVICE_DOES_NOT_EXIST) when WGC runs under
  the service model, while the same machine runs Win32CaptureSample fine
  [verified: https://github.com/LizardByte/Sunshine/issues/2846].
- **DDA cannot be used from session 0 either.** GStreamer maintainers answering the same
  question about `d3d11screencapturesrc`: "service process has limited privileges and it's
  isolated" — the recommended fix is to `CreateProcessAsUser()` and spawn the capture process
  in the user session (2024-06-19)
  [verified: https://discourse.gstreamer.org/t/cannot-initialize-d3d11screencapturesrc-in-a-windows-service/1780].
- **The working pattern (what Sunshine does)**: a service, `sunshinesvc.exe`, runs as
  LocalSystem in session 0 and spawns `sunshine.exe` **as LocalSystem but in the active
  console session**, restarting it on crash. Running as LocalSystem-in-console-session is what
  lets Moonlight interact with the Winlogon UI and UAC dialogs
  [verified: https://github.com/loki-47-6F-64/sunshine/pull/137 (cgutman) and
  https://deepwiki.com/qiin2333/foundation-sunshine/12.3-service-installation]. The child is
  held in a Job Object with `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE` (so it dies if the service
  dies) and `JOB_OBJECT_LIMIT_BREAKAWAY_OK` (so launched apps survive a service restart)
  [verified: same DeepWiki page].
- **Secure-desktop capture requires desktop hopping.** Running as SYSTEM is *not* sufficient,
  because the UAC prompt lives on a different desktop. The pattern is a loop that calls
  `OpenInputDesktop()` (→ the desktop currently receiving input) and `SetThreadDesktop()` on
  the capture/injection thread, then recreates the D3D11 device and the duplication object
  after the switch
  [verified: https://github.com/gnif/LookingGlass/issues/263 (Looking Glass — "running as the
  SYSTEM user wasn't sufficient… opening the input desktop and setting it as the current
  thread desktop worked"), and https://github.com/wh0amitz/TailVNC which explicitly "follows
  users across desktop transitions including the default desktop, Winlogon (login screen), UAC
  secure desktop, and lock screen via OpenInputDesktop/SetThreadDesktop"].
- Caveat from the same body of evidence: `OpenInputDesktop()` can fail for reasons other than
  the secure desktop (non-interactive window station, insufficient access), so failure is
  **not** proof that the machine is locked
  [verified: search result quoting the Rapidshot/punktfunk discussions].
- A thread that has a desktop-duplication object must be re-created after
  `SetThreadDesktop` — `SetThreadDesktop` fails if the thread has windows/hooks, so this
  belongs on a dedicated capture thread [inference from Win32 semantics].
- `SetThreadDesktop` only helps a process that already has SYSTEM/appropriate rights on the
  `Winlogon` desktop; a normal user process cannot open it [inference].

### 1.5 Display off / asleep / locked / RDP-disconnected

- With **no active display output** (monitor powered off on some hardware, lid closed,
  headless GPU/VM), Windows has nothing to compose to and DDA yields black/no frames
  [verified: https://www.helpwire.app/blog/teamviewer-screen-cannot-be-captured-at-the-moment/ and
  https://github.com/jonnyck-dev/headless-display-fix].
- **Screen locked**: the desktop still composes; capture works *if* you are on the right
  desktop (see 1.4). Sunshine documents capturing the lock screen and UAC prompt when run as
  SYSTEM [verified: search result quoting Sunshine docs/PR #137].
- **RDP disconnect**: an RDP session that disconnects tears the session's desktop down;
  the console session is a different session. This is the classic "works until someone RDPs in"
  failure and is why signage fleets pin to the console session [inference].
- **Windows Server 2022 RemoteApps** now sandbox sessions and `IDXGIOutputDuplication` fails
  there [verified: https://learn.microsoft.com/en-us/answers/questions/3856696/did-something-change-in-server-2022-remoteapps-to].

### 1.6 What the incumbents do

| Product | Capture | Notes |
|---|---|---|
| **Sunshine** | DDA primary, WGC alternate, AMD display capture | `src/platform/windows/display_base.cpp` has `test_dxgi_duplication()` to validate an output before use [verified: https://deepwiki.com/LizardByte/Sunshine/5.1-video-capture]. Service spawns a SYSTEM process in the console session. |
| **RustDesk** | DDA on Windows via the `scrap` crate | Frames → libyuv → VP8/VP9/AV1/H264/H265; hardware path via `hwcodec` which uses **D3D11VA rather than CUDA on Windows, deliberately, to avoid system freezes** [verified: https://deepwiki.com/rustdesk-org/hwcodec and https://deepwiki.com/rustdesk/rustdesk/5.1-video-capture-and-encoding]. They have an open PR to *recover* DXGI capture after access loss [verified: https://github.com/rustdesk/rustdesk/pull/16024]. |
| **Parsec** | Not public. Ships its own IddCx virtual display driver (parsec-vdd) and a "privacy mode" | [verified: https://github.com/nomi-san/parsec-vdd, https://support.parsec.app/hc/en-us/sections/32361161093780-Virtual-Display-Driver-VDD] |
| **OBS** | Defaults to WGC on Win10 1903+; regressed to DXGI once and it was filed as a bug | [verified: https://github.com/obsproject/obs-studio/issues/13719] |

---

## 2. ENCODE

### 2.1 Which integration layer

Three options: vendor SDK direct (NVENC / AMF / oneVPL), FFmpeg (`h264_nvenc`, `hevc_amf`,
`hevc_qsv`), or Media Foundation.

- **Vendor SDK direct** is the only way to get all the low-latency knobs (reference-frame
  invalidation, per-frame IDR, LTR control, async completion events, intra-refresh waves) and
  true zero-copy from a D3D11 texture. FFmpeg exposes a *subset*; Media Foundation exposes
  even less and adds a COM/MFT pipeline you do not control [inference, grounded in the
  parameter inventories in 2.2–2.4].
- **Counter-evidence worth weighing**: RustDesk ships FFmpeg-based hardware encoders in
  `hwcodec` and it is a shipping product at scale
  [verified: https://deepwiki.com/rustdesk-org/hwcodec]. GStreamer's `nvd3d11h265enc` takes
  D3D11Memory directly (NV12/P010/Y444/Y444_16LE and RGB formats) and outputs main/main-10/
  main-444/main-444-10 — a genuinely zero-copy managed path
  [verified: https://gstreamer.freedesktop.org/documentation/nvcodec/nvd3d11h265enc.html].

### 2.2 NVENC (Video Codec SDK 13.x)

All from the NVENC Video Encoder API Programming Guide
[verified: https://docs.nvidia.com/video-technologies/video-codec-sdk/13.0/nvenc-video-encoder-api-prog-guide/index.html]:

- **Tuning info + presets**: four tuning infos (high quality, low latency, ultra-low latency,
  lossless) × seven presets P1 (fastest) → P7 (slowest). §3.3 names the ultra-low-latency +
  CBR combination explicitly for "Cloud gaming, Streaming, Video conferencing" on a
  "strictly bandwidth-constrained channel". Setting a preset auto-configures the rest for that
  tuning info.
- **Rate control**: §3.8.3 — `NV_ENC_PARAMS_RC_CBR`. The guide does not state a 1-frame VBV
  number; the practical recipe (`vbvBufferSize = bitrate / fps`, i.e. one frame of VBV, plus
  `vbvInitialDelay` equal to it) is the community/OBS convention
  [verified for the convention: https://obsproject.com/kb/advanced-nvenc-options and
  https://remio.net/blog/hardware-encoder-comparison] [inference that it is the right setting for Swoop].
- **Look-ahead** (§8.2) buffers N frames and returns `NV_ENC_ERR_NEED_MORE_INPUT` until full —
  i.e. it *adds N frames of latency*. Must be off. Same for B-frames.
- **Intra refresh** (§8.13 Error Resiliency): `intraRefreshPeriod` + `intraRefreshCnt` encode
  consecutive slices as intra over a wave of frames, avoiding the bitrate spike of a full IDR.
  For H.264/HEVC the wave is slice-based.
- **Reference frame invalidation** (§8.13): on packet loss the client tells the encoder to
  invalidate a specific frame, and no subsequent frame will reference it — **recovery without
  a keyframe**. This is the single biggest quality lever for a lossy link and it is not
  reachable through FFmpeg. Parsec/Sunshine-class products live on this.
- **Async mode** (§6.1): `NV_ENC_INITIALIZE_PARAMS::enableEncodeAsync = 1` +
  `NvEncRegisterAsyncEvent` with Win32 event objects, so you wait on completion rather than
  spin. Windows-only feature.
- **Input formats** (§3.5): "Always supported" list includes **NV12, IYUV, ARGB and ABGR**.
  NVENC performs the RGB→YUV conversion internally, so a `B8G8R8A8_UNORM` desktop-duplication
  texture can be fed **straight in with no shader and no VideoProcessor**
  [verified: https://forums.developer.nvidia.com/t/video-codec-buffer-formats-supported-w-d3d11/210169 and
  the SDK format list]. ARGB defaults to 4:2:0 subsampling; YUV444 output from ARGB input works
  if you configure it [verified: https://forums.developer.nvidia.com/t/nvenc-yuv444-from-argb-format/189415].
  **This is a concrete, measurable NVIDIA advantage over AMF/QSV for this workload.**
- **Max resolution**: H.264 4096×4096, HEVC 8192×8192, AV1 4096×2160
  [verified: https://en.wikipedia.org/wiki/Nvidia_NVENC and the StreamFX NVENC wiki]. For a
  "giant multi-output canvas" (e.g. 3×4K side by side = 11520×2160) **H.264 cannot do it and
  AV1 cannot do it; HEVC can, up to 8192 wide.** Beyond that you must tile into multiple
  encodes [inference].
- **Concurrent sessions**: the official support matrix today lists **12 concurrent encode
  sessions** for consumer GeForce parts across the range (RTX 5050 → older)
  [verified: https://developer.nvidia.com/video-encode-and-decode-gpu-support-matrix-new, read 2026-09-17].
  History: 3 → 5 (Mar 2023) → 8 with SDK 12.2 (Windows driver ≥551.76) → 12
  [verified: https://www.tomshardware.com/news/nvidia-increases-concurrent-nvenc-sessions-on-consumer-gpus,
  https://videocardz.com/newz/nvdia-geforce-gpus-now-support-up-to-8-concurrent-nvenc-encoding-sessions].
  Most consumer GPUs have **1** NVENC die; RTX 5070 Ti/5080/5090 have 2–3; RTX PRO 6000
  Blackwell (GB202) has 4 [verified: support matrix; and
  https://arxiv.org/html/2606.29179 for the 4-engine part].
- **Split-Frame Encoding (SFE)**: splits one frame across multiple on-die NVENCs. Near-linear
  throughput (3.81× on 4 engines), **adds no latency at 4K and reduces it at 8K**
  [verified: https://arxiv.org/abs/2511.18687 (Nov 2025) and https://arxiv.org/html/2606.29179].
  Only relevant on multi-NVENC parts.
- **Measured encode latency**: ~7 frames of pipeline latency across presets/tunings, and
  notably *invariant to preset* — you can run P7 at the same latency as P1, which is not true
  of CPU encoders or most competing hardware
  [verified: https://arxiv.org/html/2605.01187v1 and https://arxiv.org/pdf/2511.18688].
  Reported per-frame encode time: **1–3 ms at 1080p60 HEVC on Ada**, "<5 ms at 1080p60 once
  configured with B-frames off and a 1-frame VBV"
  [verified: https://remio.net/blog/hardware-encoder-comparison]. Note the tension between
  "7 frames" (pipeline, measured with default async depth) and "1–3 ms" (per-frame encode
  time); with async depth 1 and no lookahead you should land near the latter
  [inference — **verify on your own hardware**].

### 2.3 AMD AMF

From the AMF Video Encode API doc
[verified: https://github.com/GPUOpen-LibrariesAndSDKs/AMF/blob/master/amf/doc/AMF_Video_Encode_API.md]:

- **`ULTRA_LOW_LATENCY` usage**: rate control `LCVBR`, `ENFORCE_HRD` on, small VBV
  (**735 kbit**), `MAX_CONSECUTIVE_BPICTURES = 0`. `LOW_LATENCY` usage: `PCVBR`, 4 Mbit VBV,
  allows overshoot for quality. Also HQLL (quality + low latency).
- **Async**: `SubmitInput(AMFSurface)` / `QueryOutput(AMFBuffer)`. In transcoding usage the
  encoder wants ≥3 input frames before producing output; low-latency usages do not.
- **LTR**: `MAX_LTR_FRAMES`, index marking, and a bitfield to select which LTRs a frame may
  reference — AMF's equivalent of reference-frame invalidation. Per-frame IDR via
  `FORCE_PICTURE_TYPE = IDR` with `IDR_PERIOD = 0`.
- **Intra refresh**: `INTRA_REFRESH_NUM_MBS_PER_SLOT`.
- **Max frame size**: width 64–4096, height 64–4096 (hardware-dependent). **AMF's documented
  H.264/HEVC frame cap is 4096 in both axes** — a hard constraint for wide canvases on AMD.
- **RGB input**: the doc does not list RGB as a first-class encoder input; AMF's colour
  handling goes through its converter component. Plan on an `AMFComponent` colour-space
  conversion or a D3D11 `VideoProcessorBlt` / compute shader BGRA→NV12 before the encoder
  [inference — **verify**; the doc references colour-profile params but does not confirm direct
  BGRA encode].

### 2.4 Intel oneVPL / QSV

- **RGB4 → NV12 requires an explicit VPP stage.** Intel's guide: "applications can perform
  H.264 encoding of RGB4 (RGB32) frames by using a VPP stage before encoding that converts
  RGB4 to the NV12 format required as input to the encoding stage"
  [verified: https://intel.github.io/libvpl/latest/programming_guide/VPL_prg_encoding.html].
- **4:4:4**: set `FourCC = MFX_FOURCC_RGB4` and `ChromaFormat = MFX_CHROMAFORMAT_YUV444`, then
  `MFXVideoENCODE_Query()` to check platform support [verified: same page].
- **`AsyncDepth`**: tells the runtime how many async ops you will queue before syncing;
  `QueryIOSurf` sizes the surface pool from it. `AsyncDepth = 1` is the low-latency setting
  [verified: same page + https://intel.github.io/libvpl/latest/API_ref/VPL_structs_vpp.html].
- oneVPL is the successor to MSDK; `vpl-gpu-rt` is the GPU runtime
  [verified: https://github.com/intel/vpl-gpu-rt/releases].

### 2.5 4:4:4, 10-bit and whether browsers can decode it

- **Browsers cannot be relied on for HEVC 4:4:4 over WebRTC.** Chrome's HEVC WebRTC support
  shipped in M136 (see §4) and is hardware-only; HEVC **Range Extensions** (4:2:2/4:4:4,
  12-bit) decode exists only on specific hardware — Apple Silicon from Chrome 117, and NVIDIA
  16/20–50 series from **Chrome 137**
  [verified: https://github.com/StaZhu/enable-chromium-hevc-hardware-decoding/blob/main/README.md].
  That is a *video element / WebCodecs* capability; whether the **WebRTC** RTP path negotiates
  a RExt profile-id at all is a separate question I could not confirm.
  **[UNVERIFIED — assume 4:2:0 Main/Main10 for WebRTC, 8-bit.]**
- Parsec's 4:4:4 mode exists but is a native-client feature gated to NVIDIA GTX 1000+/Intel
  11th-gen+ hosts and paid tiers
  [verified: https://support.parsec.app/hc/en-us/articles/32381568346644-Hardware-and-Software-Compatibility].
- **Practical consequence for Swoop**: crisp text on signage/TouchDesigner UIs must come from
  bitrate + intra-refresh + a high-quality preset at 4:2:0, not from 4:4:4 [inference]. AV1's
  Screen Content Coding tools are the real answer to text quality (100–500 kbps for screen
  content, "not possible with other video codec standards")
  [verified: https://visionular.ai/av1-for-webrtc/] — but see §4 for AV1 encode availability.

### 2.6 GPU contention with TouchDesigner

- NVENC is separate silicon from the CUDA/graphics engines and cannot be used for rendering
  [verified: https://obsproject.com/forum/threads/nvenc-actually-uses-a-lot-of-gpu-resources-and-watts.154685/].
  **But** some encoder features (look-ahead, psycho-visual tuning, "max quality") internally
  use CUDA and *will* steal from the render app [verified: same thread] — another reason to
  stay on P1–P4 ULL with lookahead off.
- Memory bandwidth is shared. NVIDIA's own forum reports NVENC throughput collapsing from
  200+ fps to 60 fps and latency rising from <10 ms to 30 ms under a GPU-heavy workload
  [verified: https://forums.developer.nvidia.com/t/running-gpu-heavy-tasks-significantly-decrease-nvenc-performance/50674].
  **On a TouchDesigner box saturating the GPU, budget encode latency of 20–30 ms, not 3 ms.**
- There is **no encoder priority API**. The available levers are: capture at a lower rate
  (`MinUpdateInterval`/dirty-rect gating), lower resolution, and avoid CUDA-backed encoder
  features [inference].
- The capture step itself competes: OBS guidance is that rendering lag for the encoder is the
  reason not to max the GPU [verified: same OBS thread].

---

## 3. SOFTWARE FALLBACK

- **x264 `ultrafast` + `zerolatency`** is the reference software fallback and is what everyone
  uses; `zerolatency` disables lookahead and B-frames
  [verified: https://obsproject.com/forum/threads/x264-tunes-fastdecode-vs-zerolatency.42247/ and
  https://fluendo.com/blog/benchmarking-remote-desktop-coding-tools-for-daas-and-vdi/, which uses
  `x264enc ultrafast+zerolatency` as the reference point precisely because it stays relevant in
  remote desktop].
- **openh264** (Cisco, BSD, with Cisco paying the AVC royalties for their binary) is the other
  option and is what libwebrtc ships as its software H.264. Lower quality than x264 at the
  same bitrate but zero licensing friction [inference on the tradeoff; the Cisco binary
  arrangement is well established].
- **Software HEVC is not viable at low latency.** "Low throughput makes x265 transcoding very
  expensive"; NVENC (both H.264 and HEVC) is *significantly* faster than x264 and x265 both at
  ultrafast+zerolatency; LCEVC-enhanced H.264 beat `x265enc ultrafast`
  [verified: https://streaminglearningcenter.com/codecs/the-quality-cost-of-low-latency-transcoding.html and
  https://fluendo.com/blog/benchmarking-remote-desktop-coding-tools-for-daas-and-vdi/].
  **Recommendation: software path = H.264 only (openh264 or x264), never HEVC.**
- VP8 via libvpx is the other safe browser-universal software fallback, and is what RustDesk
  defaults to [verified: RustDesk codec list above].

---

## 4. WEBRTC LIBRARY FOR THE HOST

### 4.0 The browser-side constraint that decides everything

- **Chrome shipped H.265/HEVC in WebRTC in M136** (Intent to Ship dated **2025-03-03**),
  send *and* receive, on all six Blink platforms, behind `WebRtcAllowH265Send` /
  `WebRtcAllowH265Receive`, now on by default. Explicitly **hardware-only — "we will not
  provide a software fallback."** Estimated HW coverage: 75% Windows, 99% macOS, 86% Android,
  90% iOS. Safari/WebKit already shipped
  [verified: https://groups.google.com/a/chromium.org/g/blink-dev/c/3h8lL8a377c, 2025-03-03;
  https://chromestatus.com/feature/5153479456456704].
- **Edge does NOT enable it by default** — it does not advertise H.265 in the SDP offer
  regardless of hardware
  [verified: https://learn.microsoft.com/en-us/answers/questions/5880331/h-265-hevc-not-published-sent-via-webrtc-chrome-su].
  **Signage/kiosk operators on Edge will silently fall back to H.264.** Firefox: no WebRTC
  HEVC. **[Firefox status UNVERIFIED but no evidence of support found.]**
- **AV1 in WebRTC**: broadly *decodable* (Chrome/Edge/Firefox), but AV1 *encode* in WebRTC is
  still not broadly available in 2026 and is limited to newer high-end devices
  [verified: https://antmedia.io/webrtc-browser-support/ and
  https://www.forasoft.com/learn/video-encoding/articles/av1-state-2026]. For Swoop the browser
  only *decodes*, so AV1 is viable as a future host-side encode option on Ada/Blackwell
  + Intel Arc + RDNA3, with H.265 and H.264 below it [inference].
- **Practical ladder: H.265 → H.264 → (later) AV1.** H.264 must always be present.

### 4.1 Candidate comparison

| Library | Lang | H.265 payload | Congestion control | NACK/RTX/FEC | ICE/TURN | External encoded frames | Licence | Verdict |
|---|---|---|---|---|---|---|---|---|
| **Google libwebrtc** | C++ | Yes, upstream since the M136 work | **GCC + transport-wide-cc, the reference implementation** | Full (NACK, RTX, ULPFEC/FlexFEC, PLI/FIR) | Full, incl. TURN over TCP/TLS, mDNS candidates | Custom `VideoEncoderFactory`; the modern pattern is a `VideoTrackSourceInterface` producing `kNative` buffers unwrapped by a matching encoder (`internal_source` is deprecated) [verified: https://chromium.googlesource.com/external/webrtc/+/master/modules/video_coding/g3doc/index.md and https://groups.google.com/g/discuss-webrtc/c/8DC2iF0eP6s] | BSD-3 | **Best protocol behaviour, worst build/maintenance story** |
| **libdatachannel** | C/C++ | **Yes** — `rtcSetH265Packetizer` | **No BWE.** Maintainer (2021-10-12): "TWCC is not implemented for now"; only REMB *reporting* exists. There is a `rtcChainPacingHandler` [verified: https://github.com/paullouisageneau/libdatachannel/discussions/505 and DOC.md] | NACK via `rtcChainRtcpNackResponder` (RTX per RFC4588), `rtcChainPliHandler`, `rtcChainRembHandler`, `rtcChainRtcpSrReporter`. No FEC found | libjuice (default): **UDP only — no TURN over TCP/TLS**. libnice backend adds TCP/TLS for the TURN *control* connection only. mDNS candidate resolution supported (draft-03) [verified: https://github.com/paullouisageneau/libdatachannel README + DOC.md] | Trivial — you hand it RTP or frames | **MPL-2.0** (since 0.18) | **Smallest, simplest, but you write the congestion controller** |
| **GStreamer webrtcbin / webrtcsink** | C (+ gstreamer-rs) | Yes (`video/x-h265`) | **GCC** (`webrtcsink` congestion-control = disabled / homegrown / **gcc default**) [verified: https://gstreamer.freedesktop.org/documentation/rswebrtc/webrtcsink.html] | Retransmission ("do-retransmission") configurable | Full via libnice | Native D3D11 zero-copy: `d3d11screencapturesrc` → `nvd3d11h265enc` → `webrtcsink`, all in D3D11Memory [verified: https://gstreamer.freedesktop.org/documentation/d3d11/d3d11screencapturesrc.html + nvd3d11h265enc docs] | LGPL-2.1 (plus plugin licences) | **Fastest to a working demo; heaviest runtime; LGPL + plugin-licence review needed** |
| **str0m** | Rust | **Not listed** — h264/vp8/vp9/opus referenced; no H.265 | **BWE + Transport Wide CC present** [verified: https://github.com/algesten/str0m README] | Yes | **No TURN, no interface enumeration** — sans-IO, you supply both. "Less testing for peer-to-peer vs server" | You feed it encoded frames; no capture/encode inside | MIT/Apache-2.0 | Good BWE, **missing H.265 and TURN** |
| **webrtc-rs** | Rust | Has an H.265 packetizer but it is buggy — open issue to "fix and verify H265 packetizer/depacketizer" as of 2026-03-01 [verified: https://github.com/webrtc-rs/webrtc/issues/779] | Some (GCC port) | Yes | Yes | Yes | MIT/Apache-2.0 | **In the middle of an architecture rewrite**: v0.17.0 (2026-01-31) froze the Tokio-coupled API to bug-fixes-only; v0.20.0 (2026-07-31) is the first stable sans-IO release on the new `rtc` crate [verified: https://webrtc.rs/blog/2026/01/31/... and https://webrtc.rs/blog/2026/07/31/announcing-webrtc-v0.20.0.html]. Moving target. |
| **Pion** | Go | Registerable in the MediaEngine, but "**broken HEVC support has been reported**" now that Chrome added it [verified: https://github.com/pion/webrtc/issues/3137] | Yes (`pion/interceptor` GCC) | Yes | Yes | Yes | MIT | Go runtime + GC in a 4K zero-copy path is the wrong fit [inference] |
| **LiveKit Rust SDK** | Rust over libwebrtc | Inherits libwebrtc | Inherits libwebrtc (GCC/TWCC) | Full | Full | Via libwebrtc encoder factory | Apache-2.0 | **Still "Developer Preview — not ready for production", APIs may change** [verified: https://github.com/livekit/rust-sdks]. `libwebrtc` crate is actively released (v0.3.48). Also SFU-oriented, not P2P-oriented. |

### 4.2 How Sunshine does transport (for contrast)

Sunshine does **not** use WebRTC. It implements the NVIDIA GameStream protocol: NVHTTP for
discovery/pairing, **RTSP** for negotiation, **ENet** (reliable UDP) for the control channel,
and three plain UDP streams for video/audio/control
[verified: https://deepwiki.com/LizardByte/Sunshine/4-core-streaming-architecture and
https://deepwiki.com/LizardByte/Sunshine/4.4-udp-streaming-and-data-plane]. That is the right
answer when your client is a native app you also write. **It is not available to Swoop because
the client is a browser** [inference].

### 4.3 The congestion-control decision

This is the crux. A remote desktop over the open internet with TURN fallback lives or dies on
**sender-side bandwidth estimation**. libdatachannel gives you RTP plumbing and a pacer but
**no estimator** — you would be writing GCC (or a delay-based equivalent) yourself and
validating it against real networks. That is months of work and the highest-risk item in the
whole project [inference, grounded in the maintainer's own statement in discussion #505].

libwebrtc and GStreamer's `webrtcsink` both ship GCC. str0m ships BWE+TWCC but not H.265 or
TURN.

---

## 5. LANGUAGE: C++ vs RUST

**There is no measurable performance reason to prefer C++ here.** The hot path is: a D3D11
texture handed to a hardware encoder, and a byte buffer handed to a packetizer. Both languages
compile to the same thing; the work is in the GPU and the NIC [inference].

The real deciding factors:

- **Library gravity.** If you pick libwebrtc, you are writing C++ (or paying for a binding
  layer — LiveKit's `libwebrtc`/`webrtc-sys` crates, or shiguredo's `webrtc-rs` bindings,
  v0.146.2 released 2026-03-27 [verified: https://github.com/shiguredo/webrtc-rs]). If you pick
  libdatachannel or GStreamer, either language works.
- **Win32/D3D11/WASAPI from Rust is a solved problem.** The `windows` crate covers DXGI
  Desktop Duplication, Windows.Graphics.Capture *and* WASAPI; `pinray` is a current project
  doing exactly that trio via the `windows` crate with no wrappers
  [verified: https://github.com/Itz-Agasta/pinray]. `win_desktop_duplication` even wires DDA
  to NVENC/QuickSync [verified: https://crates.io/crates/win_desktop_duplication].
- **Production proof in each**: Sunshine (C++) and RustDesk (Rust) both ship at scale; RustDesk
  proves the Rust + FFI-to-vendor-SDK model specifically — `hwcodec` is "a bridge between
  high-level Rust code and low-level C++ hardware SDKs"
  [verified: https://deepwiki.com/rustdesk-org/hwcodec].
- **Your repo already has a Rust toolchain** (`agent/host`, Tauri). Adding a C++ toolchain
  (and a libwebrtc `depot_tools`/`gn`/`ninja` build) to a monorepo whose installer pipeline is
  already delicate is an operational cost, not a technical one [inference].
- **Rust's real win here is the failure modes this domain is made of**: desktop-switch races,
  device-lost, surface lifetime across a frame pool, ACCESS_LOST recovery, disconnect cleanup.
  Those are use-after-free and data-race shaped. [inference]

**Recommendation: Rust**, with `unsafe` FFI to NVENC/AMF/oneVPL (or to a thin C shim you own),
unless you choose libwebrtc — in which case a C++ core with a Rust supervisor shim, or the
LiveKit `libwebrtc` crate, is the pragmatic compromise.

---

## 6. MULTI-VIEWER

### 6.1 Encode-once, fan out to N PeerConnections — recommended

Rationale:
- NVENC allows 12 concurrent sessions on GeForce
  [verified: NVIDIA support matrix], so per-viewer encoding is *possible* up to 12 — but each
  session costs GPU, VRAM and memory bandwidth on a box already running TouchDesigner, and
  most consumer cards have **one** NVENC die [verified: same matrix]. Per-viewer encoding
  multiplies the contention documented in §2.6 [inference].
- Sunshine hits exactly this wall: multi-client streaming produces
  `Failed to acquire encoder mutex [0x887A0001]` and both clients go black
  [verified: https://github.com/LizardByte/Sunshine/issues/795 and #3887]. Evidence that
  bolting multi-viewer onto a single-viewer encoder design goes badly.
- Parsec supports up to **20 concurrent guests** by default but **shares one bitrate budget**:
  "if the first connection was set at 30 Mbps and you have 5 friends connected, each friend
  will only get a 6 Mbps stream"
  [verified: https://support.parsec.app/hc/en-us/articles/32361376782228-Max-Client-Connections-To-Your-Host].
  That reads as encode-once-fan-out with a shared budget [inference].

### 6.2 The keyframe (PLI) problem

With one encoder and N peers, **a PLI from any one viewer forces a keyframe that every viewer
receives** — a bitrate spike and a quality dip for people who were fine
[verified in the SFU context: https://getstream.io/blog/simulcast-video-call-bandwidth/ —
"those other WebRTC clients respond by generating new keyframes, which need to be sent to
everyone, increasing bandwidth requirements for the entire session"].

Mitigations, in order of preference:
1. **Use NVENC reference-frame invalidation instead of keyframes** where the loss is
   identifiable — recovers without an IDR [verified: NVENC guide §8.13]. Requires you to map
   RTP loss back to encoded frames, which means you need your own feedback path (a DataChannel
   works) rather than relying on PLI [inference].
2. **Intra refresh** so the stream is continuously self-healing and PLIs become rare
   [verified: NVENC §8.13, AMF `INTRA_REFRESH_NUM_MBS_PER_SLOT`].
3. **Rate-limit PLI → IDR** (e.g. at most one IDR per second across all viewers, coalescing
   requests) [inference].
4. **Temporal SVC (L1T2/L1T3)** lets you drop the top temporal layer per-viewer with no
   keyframe, halving a slow viewer's bitrate. Supported in WebRTC for VP8/VP9/AV1
   [verified: https://getstream.io/blog/simulcast-video-call-bandwidth/ and
   https://www.w3.org/TR/webrtc-svc/]. **H.264/H.265 temporal layers exist in NVENC
   (hierarchical P) but browser-side H.265 SVC negotiation is unproven** [UNVERIFIED].

### 6.3 Bitrate adaptation with one encoder

Three strategies, pick by viewer count:
- **1 viewer (the 95% case)**: single encoder, drive its bitrate directly from that peer's BWE.
  Optimal.
- **2–4 viewers**: **two encoder tiers** (e.g. a "full" tier and a "reduced" tier at
  ~1/3 resolution+bitrate), assign each peer to a tier from its BWE, move peers between tiers
  on hysteresis. This is manual simulcast and costs 2 NVENC sessions, well inside the 12 limit
  [inference]. `webrtcsink` already implements the divide-and-conquer version: "divide the
  overall allocated bitrate by the number of encoders", customisable via `define-encoder-bitrates`
  [verified: https://gstreamer.freedesktop.org/documentation/rswebrtc/webrtcsink.html].
- **Never**: lowest-common-denominator bitrate. One phone on 4G would ruin the operator's
  1 Gbps session.

### 6.4 Recommended design

One capture → one (or two-tier) encoder → an **RTP fan-out layer** that packetizes once and
sends the same RTP payload (with per-peer SSRC/sequence rewriting) to N peers, plus per-peer
RTX/NACK buffers. Each peer gets its own DataChannel for input/cursor/clipboard.
Audio: one Opus encode, same fan-out. [inference]

---

## 7. INPUT INJECTION

### 7.1 Mouse

- `SendInput` with `MOUSEEVENTF_ABSOLUTE | MOUSEEVENTF_VIRTUALDESK | MOUSEEVENTF_MOVE`.
  Without `VIRTUALDESK`, absolute coordinates map to the **primary monitor only**; with it they
  map to the entire virtual desktop. Absolute coordinates are normalised 0–65535, with
  (0,0) = top-left and (65535,65535) = bottom-right of the mapped surface
  [verified: https://learn.microsoft.com/en-us/windows/desktop/api/winuser/nf-winuser-mouse_event
  and https://filipvalentin.github.io/blog/2024/08/how-to-simulate-moving-the-mouse-cursor-through-winapi-multimonitor-setup].
  **"You should always use MOUSEEVENTF_VIRTUALDESK when using MOUSEEVENTF_MOVE."** For a
  multi-output canvas this is mandatory.
- The normalisation must use `SM_XVIRTUALSCREEN`/`SM_YVIRTUALSCREEN`/`SM_CXVIRTUALSCREEN`/
  `SM_CYVIRTUALSCREEN`, not the primary monitor's size, and must account for negative
  virtual-screen origins (monitors left of / above primary) [inference — this is the classic
  off-by-a-monitor bug].
- **Relative mouse** (`MOUSEEVENTF_MOVE` without `ABSOLUTE`) is needed for pointer-lock /
  FPS-style capture from the browser (`movementX`/`movementY`). It is subject to
  mouse acceleration and `SPI_GETMOUSESPEED`; relay raw deltas and consider temporarily
  disabling acceleration [inference].
- `mouseData` for wheel/horizontal wheel and XBUTTONs is signed but declared unsigned in some
  metadata — cast carefully [verified: https://github.com/microsoft/win32metadata/issues/933].

### 7.2 Keyboard

- **Use scancodes, not virtual keys**: `KEYEVENTF_SCANCODE` with `wScan` set and `wVk = 0`.
  A browser's `KeyboardEvent.code` is *already a physical-key identifier* (`KeyA`, `Digit1`,
  `ControlLeft`) and maps 1:1 to a PS/2 set-1 scancode — this bypasses all keyboard-layout
  translation and is the only correct approach for a remote desktop
  [inference, but this is the universally used approach; `code` semantics per
  https://developer.mozilla.org/en-US/docs/Web/API/KeyboardEvent/code].
- **Extended keys** (right Ctrl/Alt, arrows, Insert/Delete/Home/End/PgUp/PgDn, numpad Enter,
  numpad `/`, PrintScreen) need `KEYEVENTF_EXTENDEDKEY` together with the base scancode.
  Getting this wrong makes right-Alt behave as left-Alt and arrow keys act as numpad keys
  [inference].
- **Unicode** that has no scancode (emoji, IME output, paste-as-typing): `KEYEVENTF_UNICODE`
  with `wVk = 0` and `wScan` = the UTF-16 code unit; surrogate pairs go as two events
  [inference from the documented flag semantics].
- **Stuck keys on disconnect are the #1 user-visible input bug.** Maintain a set of currently
  pressed scancodes and mouse buttons per viewer; on disconnect, timeout, or viewer-switch,
  synthesise key-up/button-up for everything in the set. Do the same on desktop switch
  [inference — mandatory].

### 7.3 UIPI / integrity limits

- **UIPI blocks `SendInput`/`keybd_event` into windows owned by a higher-integrity process.**
  A medium-IL process cannot drive a high-IL (elevated) window
  [verified: https://learn.microsoft.com/en-us/archive/msdn-technet-forums/b68a77e7-cd00-48d0-90a6-d6a4a46a95aa
  and https://codenote.net/en/posts/windows-admin-elevation-blocks-chatgpt-computer-use-uipi/].
- **Escape hatches**, in increasing order of pain:
  1. **Run as SYSTEM in the console session** (Sunshine's model) — highest integrity, drives
     everything [verified: Sunshine PR #137].
  2. **uiAccess = true in the manifest.** Requires (a) an Authenticode signature chaining to a
     trusted root in the *machine* store, and (b) installation in a directory writable only by
     administrators (i.e. `Program Files`). Then the process "can set the foreground window and
     drive any application window by using the SendInput function". Narrator, TeamViewer and
     AnyDesk take this route
     [verified: https://learn.microsoft.com/en-us/previous-versions/windows/it-pro/windows-10/security/threat-protection/security-policy-settings/user-account-control-only-elevate-uiaccess-applications-that-are-installed-in-secure-locations].
  3. Run elevated (high IL) — still cannot touch the secure desktop.
- **Google Project Zero published a UIPI/uiAccess bypass against Administrator Protection in
  Feb 2026** [verified: https://projectzero.google/2026/02/windows-administrator-protection.html].
  Expect Microsoft to tighten uiAccess; **do not build the architecture on uiAccess alone**
  [inference].
- **Secure desktop injection**: same `OpenInputDesktop`/`SetThreadDesktop` dance as capture
  (§1.4), from a SYSTEM process in the console session. TailVNC does exactly this
  [verified: https://github.com/wh0amitz/TailVNC].

### 7.4 Ctrl+Alt+Del

- You cannot synthesise SAS with `SendInput` — it is intercepted below the input stack.
  Use `SendSAS()` from `sas.dll`.
- It requires the `SoftwareSASGeneration` policy: `3` = "Services and Ease of Access
  applications". Group Policy path: *Computer Configuration → Administrative Templates →
  Windows Components → Windows Logon Options → Disable or Enable software Secure Attention
  Sequence*. Windows 7+
  [verified: https://learn.microsoft.com/en-us/archive/blogs/technet/itasupport/sendsas-step-by-step
  and https://eddiejackson.net/wp/?p=19672].
- **Swoop's installer should set this registry value** (`HKLM\SOFTWARE\Microsoft\Windows\
  CurrentVersion\Policies\System\SoftwareSASGeneration = 3`) as part of fleet provisioning,
  rather than toggling it at runtime [inference].

### 7.5 Touch / pen

- `CreateSyntheticPointerDevice(PT_TOUCH | PT_PEN, maxCount, mode)` then
  `InjectSyntheticPointerInput(handle, POINTER_TYPE_INFO[], count)`. For `PT_PEN`, `maxCount`
  and `count` **must be 1**
  [verified: https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-createsyntheticpointerdevice
  and https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-injectsyntheticpointerinput].
- Relevant for kiosks: a browser client on a tablet sending `PointerEvent` with
  `pointerType: "touch"` can be injected as real touch, which many kiosk apps require (they
  handle `WM_POINTER`/touch gestures but not mouse) [inference].

---

## 8. CLIPBOARD

- **Change notification**: `AddClipboardFormatListener(hwnd)` → the window receives
  `WM_CLIPBOARDUPDATE`. This is asynchronous/posted, not synchronous
  [verified: https://learn.microsoft.com/en-us/windows/win32/dataxchg/using-the-clipboard].
  It supersedes the fragile `SetClipboardViewer` chain.
- **Formats to support**, in priority order:
  - `CF_UNICODETEXT` — always.
  - `"HTML Format"` (registered format) — rich paste from/to browsers; has a byte-offset
    header that must be recomputed, a classic source of corruption [inference].
  - `CF_DIB` / `CF_DIBV5`, plus the registered `"PNG"` format — images. PNG round-trips
    alpha correctly where `CF_DIB` does not [inference].
  - `CF_HDROP` — file lists. **Treat as out of scope for v1**: transferring the *files* means a
    virtual file system or an upload flow, not a clipboard blob [inference].
  - `CF_RTF` (registered `"Rich Text Format"`) — optional.
- **Delayed rendering** for large payloads: call `SetClipboardData(format, NULL)` to advertise
  a format without producing data, then serve it on `WM_RENDERFORMAT` (single format) or
  `WM_RENDERALLFORMATS` (owner is exiting)
  [verified: https://learn.microsoft.com/en-us/windows/win32/dataxchg/clipboard-operations and
  https://www.codeguru.com/windows/delayed-rendering-of-clipboard-data/].
  **Critical caveat**: Windows gives up after a bounded timeout if the owner is slow —
  Raymond Chen's article is literally titled "How can I wait more than 30 seconds for a
  delay-rendered clipboard format to become rendered?"
  [verified: https://devblogs.microsoft.com/oldnewthing/20220609-00/?p=106731]. So delayed
  rendering only works if the remote round-trip fits comfortably inside that window. For a
  remote clipboard the safe design is: on `WM_CLIPBOARDUPDATE`, read a *size* and a *hash*
  locally, advertise delayed formats, and have the data already in flight [inference].
- **Echo-loop suppression**: every remote-set clipboard must be tagged. Two mechanisms, use
  both: (a) after you call `SetClipboardData`, record `GetClipboardSequenceNumber()` and
  ignore the `WM_CLIPBOARDUPDATE` that matches; (b) hash the content and drop updates whose
  hash equals the last value you applied. Sequence number alone is racy under multiple writers
  [inference].
- Windows 11 clipboard history is itself known to miss items because of the async +
  delayed-rendering interaction — a reminder that this subsystem is genuinely racy
  [verified: https://windowsforum.com/threads/why-windows-11-clipboard-history-misses-clips-async-notifications-and-delayed-rendering.395876/].
- The clipboard is **per-desktop**: on the Winlogon desktop there is effectively no user
  clipboard to sync [inference].

---

## 9. AUDIO

- **WASAPI loopback**: `IAudioClient::Initialize` with `AUDCLNT_SHAREMODE_SHARED` and
  `AUDCLNT_STREAMFLAGS_LOOPBACK`. **Loopback requires shared mode — exclusive-mode streams
  cannot loop back** [verified: https://learn.microsoft.com/en-us/windows/win32/coreaudio/loopback-recording].
- **Event-driven loopback works from Windows 10 1703 onward.** Before 1703 an event-driven
  loopback client received no events and needed a dummy render stream as a workaround
  [verified: same MS page]. Since the fleet is Win10/11, just use
  `AUDCLNT_STREAMFLAGS_EVENTCALLBACK` + `SetEventHandle` on an `AvSetMmThreadCharacteristics`
  ("Pro Audio") thread [inference].
- **Silence**: when the hardware has no loopback pin, WASAPI copies the engine's output into
  your capture buffer, which includes silence when nothing is playing
  [verified: same MS page]. In practice you should also handle
  `AUDCLNT_BUFFERFLAGS_SILENT` and the case where `GetNextPacketSize` returns 0 for long
  stretches — generate your own silence/comfort frames so the Opus timeline does not drift
  [inference]. A reported ARM64 bug has `GetNextPacketSize` always returning 0
  [verified: https://learn.microsoft.com/en-us/answers/questions/5694431/coreaudio-wasapi-loopback-on-windows-11-arm-iaudio].
- **Default period** is ~10 ms in shared mode; `IAudioClient3::GetSharedModeEnginePeriod` +
  `InitializeSharedAudioStream` can go lower, but **`IAudioClient3` low-latency shared mode is
  documented as not combinable with the loopback flag** in community reports
  [verified: https://learn.microsoft.com/en-us/answers/questions/280278/is-it-possible-to-use-software-loopback-functional].
  **Budget ~10–20 ms capture latency.** Claims of "sub-3 ms WASAPI master loopback" exist
  [verified only as a feature request: https://github.com/CodeGrogu/Moonshine/issues/25] —
  **treat as unverified.**
- **Opus settings for Swoop**:
  - Frame size **10 ms** (2.5/5/10/20/40/60 ms are the options; <10 ms forces MDCT-only modes
    **where in-band FEC is unavailable**)
    [verified: https://wiki.xiph.org/OpusFAQ and https://opus-codec.org/docs/opus_api-1.5/group__opus__encoderctls.html].
    10 ms is the sweet spot: lowest latency that still permits FEC.
  - Application `OPUS_APPLICATION_AUDIO` (system audio is music/SFX, not speech), or
    `RESTRICTED_LOWDELAY` if you want to shave the 6.5 ms look-ahead and accept no
    FEC/no-SILK [verified: same Opus docs].
  - Bitrate 96–128 kbps stereo 48 kHz for system audio [inference].
  - **In-band FEC on** (`OPUS_SET_INBAND_FEC(1)`) with a packet-loss-percentage hint fed from
    RTCP [verified: Opus encoder CTLs].
  - **DTX off.** DTX saves 85–90% during silence
    [verified: https://getstream.io/resources/projects/webrtc/advanced/dtx/] but system audio
    silence is meaningful and DTX gaps confuse some browser jitter buffers [inference].
- **Headless / no endpoint**: if there is no render endpoint, there is nothing to loop back.
  Options: (a) a virtual audio device — Steam Streaming Speakers is exactly this and "allows
  Sunshine to stream audio while muting the speakers"
  [verified: search result citing Sunshine docs / Steam]; VB-CABLE is the generic equivalent;
  (b) ship your own — the same IddCx-style driver-signing problem as §10 [inference];
  (c) degrade gracefully to no audio.
- **Muting the physical output while streaming** is exactly the Steam-Streaming-Speakers
  pattern: set the virtual device as the default render endpoint for the duration of the
  session, capture its loopback, and restore the previous default on disconnect
  [verified: same source]. For signage, this is often desirable — but **be careful**: on a
  signage box the physical audio *is the show*. Make it opt-in per machine [inference].

---

## 10. HEADLESS / VIRTUAL DISPLAY

- **With no monitor attached**, Windows composes nothing and both DDA and WGC yield black
  [verified: §1.5 sources].
- **Dummy plug** (HDMI/DP EDID emulator) is the zero-software fix and is what a signage fleet
  can do at install time for pennies [verified: https://www.helpwire.app/blog/teamviewer-screen-cannot-be-captured-at-the-moment/].
- **IddCx indirect display driver**: user-mode, no kernel component, can use any DirectX API to
  process the desktop image; creates adapters representing indirect displays, reports
  monitor connect/disconnect, supplies EDID and mode lists, supports a hardware cursor
  [verified: https://learn.microsoft.com/en-us/windows-hardware/drivers/display/indirect-display-driver-model-overview].
- **Signing**: to ship a driver you need **attestation signing through the Hardware Dev Center,
  which requires an EV code-signing certificate associated with the dashboard account**; you
  sign the CAB with the EV cert and submit it
  [verified: https://learn.microsoft.com/en-us/windows-hardware/drivers/dashboard/code-signing-attestation].
  Install via `pnputil /add-driver <inf> /install` (or `devcon`).
  **This is a real cost and a real lead time — plan for an EV cert + a Partner Center account.**
- **Open-source bases**:
  - `itsmikethetech` / `VirtualDrivers/Virtual-Display-Driver` — "add virtual monitors to your
    Windows 10/11 device… works with VR, OBS, Sunshine and/or any desktop sharing software"
    [verified: https://github.com/VirtualDrivers/Virtual-Display-Driver].
  - `nomi-san/parsec-vdd` — wraps Parsec's signed VDD; up to 4K240
    [verified: https://github.com/nomi-san/parsec-vdd].
  - `SudoMaker/SudoVDA` — 640×480 up to 7680×4320, refresh rates to 500 Hz
    [verified: https://github.com/SudoMaker/SudoVDA].
  - `ClassicOldSong/Apollo` (Sunshine fork) uses SudoVDA, creates the virtual display when the
    stream starts and removes it when the app quits, and supports headless mode on dual-GPU
    laptops without a dummy plug
    [verified: https://github.com/ClassicOldSong/Apollo].
  - Note the licensing: reusing parsec-vdd means depending on Parsec's signed binary.
    `Virtual-Display-Driver` is also sold on itch.io, so check the licence before shipping
    [verified: https://mikethetech.itch.io/virtual-display-driver/purchase].
- **Privacy mode**: Parsec's VDD documentation describes pairing "a virtual display for the
  remote session with the physical monitor for local use, keeping the two desktops independent"
  [verified: https://github.com/nomi-san/parsec-vdd]. For Swoop on signage this is the
  *headline feature*: the public-facing screen keeps showing the show while the operator works
  on a private virtual display. Parsec Warp also lists "connect in privacy mode" and virtual
  display launching [verified: https://parsec.app/warp].
- **Known trap**: Sunshine has an open issue where it duplicates DISPLAY1 despite the VDD
  creating independent virtual displays
  [verified: https://github.com/VirtualDrivers/Virtual-Display-Driver/issues/382]. Output
  selection with virtual displays present is fiddly; select by the output's stable device
  path, not index [inference].
- **Sunshine alters the refresh rate of displays it is not using**
  [verified: https://github.com/LizardByte/Sunshine/issues/3591] — a cautionary tale for a
  fleet where the display config *is* the product. **Swoop must never change display
  configuration without an explicit per-machine opt-in.**

---

## 11. PROCESS ARCHITECTURE

### 11.1 Recommended topology

```
owlette service (session 0, LocalSystem)         <- existing Rust wrapper + Python
        |
        |  WTSGetActiveConsoleSessionId()
        |  WTSQueryUserToken()  [LocalSystem only]
        |  DuplicateTokenEx() + CreateEnvironmentBlock()
        |  CreateProcessAsUser()  in a Job Object
        v
swoop-host.exe (console session, SYSTEM or user)  <- capture / encode / WebRTC / input
        |
        +-- capture thread: OpenInputDesktop/SetThreadDesktop loop, D3D11 device per desktop
        +-- encode thread(s): NVENC/AMF/QSV async completion
        +-- net thread: ICE/DTLS/SRTP, N peers
        +-- input thread: SendInput on the current input desktop
```

- `WTSGetActiveConsoleSessionId` → `WTSQueryUserToken` (**LocalSystem only**) →
  `DuplicateTokenEx` → `CreateEnvironmentBlock` → `CreateProcessAsUser`
  [verified: https://learn.microsoft.com/en-us/windows/desktop/api/Winbase/nf-winbase-wtsgetactiveconsolesessionid,
  https://learn.microsoft.com/en-us/windows/win32/api/processthreadsapi/nf-processthreadsapi-createprocessasuserw,
  and the CodeProject walkthrough].
- To run the child **as SYSTEM in the console session** (needed for secure-desktop capture and
  UIPI-free injection), duplicate the *service's own* token and set its session ID via
  `SetTokenInformation(TokenSessionId)` rather than using the user's token
  [inference; this is the documented Sunshine behaviour: "spawning sunshine.exe as LocalSystem
  in the active console session" — verified: https://github.com/loki-47-6F-64/sunshine/pull/137].
- **Job Object**: `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE` so the host cannot outlive the service;
  `JOB_OBJECT_LIMIT_BREAKAWAY_OK` if the host ever launches anything that must survive
  [verified: Sunshine's job configuration, https://deepwiki.com/qiin2333/foundation-sunshine/12.3-service-installation].
- **Crash isolation**: single-exe-in-the-service is wrong — a D3D device-lost or a vendor SDK
  fault would take down the whole Owlette agent. A supervised child also gives you a natural
  place to handle session-change events (`WTS_SESSION_LOGON`/`LOGOFF`/`CONSOLE_CONNECT`) by
  killing and relaunching [inference].
- Sunshine's supervisor gives the child 20 s to exit gracefully before `TerminateProcess`
  [verified: same DeepWiki page].

### 11.2 Secrets and config hand-off

- **Never on the command line.** Any user can read another process's command line
  (`Get-CimInstance Win32_Process`, Process Explorer, and every EDR logs it). Command lines
  land in EDR telemetry, in Sysmon event 1, and in crash dumps [inference — but this is
  settled Win32 practice].
- Preferred: an **anonymous pipe as the child's stdin** created by the service
  (`CreatePipe` + `STARTUPINFO.hStdInput` with `bInheritHandles = TRUE`), write a JSON blob,
  close. No namespace, no ACL to get wrong, no other process can open it [inference].
- Alternative: a **named pipe with an explicit SDDL** restricting to SYSTEM + Administrators,
  e.g. `\\.\pipe\owlette-swoop-<random>`, name passed on the command line (the *name* is not a
  secret), and the server verifying the client's PID via `GetNamedPipeClientProcessId`
  [inference]. Needed anyway if the service must push config *updates* to a running host.
- Do **not** use environment variables (inherited by every grandchild, visible in dumps) or a
  temp file [inference].
- This aligns with the repo's existing rule about `.tokens.enc` and never logging tokens.

### 11.3 Signing and AV/EDR

- **Authenticode-sign everything** (exe + any DLL + the installer). Even signed, a *new*
  binary shows SmartScreen warnings until the hash or publisher certificate accumulates
  reputation [verified: https://learn.microsoft.com/en-us/windows/apps/package-and-deploy/smartscreen-reputation].
  An EV cert gets reputation immediately — and you need one anyway if you go the IddCx route
  (§10) [inference].
- **Expect EDR false positives.** Swoop's behavioural fingerprint — screen capture + synthetic
  input + outbound P2P + clipboard access + a SYSTEM service spawning a console-session child —
  is *identical to* the RMM-abuse pattern that is currently the dominant intrusion vector.
  Microsoft (2026-03-03) documented signed malware deploying RMM backdoors
  [verified: https://www.microsoft.com/en-us/security/blog/2026/03/03/signed-malware-impersonating-workplace-apps-deploys-rmm-backdoors/];
  multiple vendors publish detections that "flag execution of legitimate RMM binaries and
  correlate with post-install behaviors"
  [verified: https://socprime.com/active-threats/endpoint-detection-of-recent-rmm-distribution-cases/
  and https://www.forcepoint.com/blog/x-labs/screenconnect-attack].
- **Mitigations**: submit binaries to Microsoft's Defender false-positive portal pre-release
  [verified: https://www.microsoft.com/en-us/security/blog/2018/08/16/partnering-with-the-industry-to-minimize-false-positives/];
  keep a stable publisher identity (do not rotate certs casually); install under
  `Program Files` (also required for uiAccess); ship a documented allowlist (paths, hashes,
  cert thumbprint, outbound endpoints) for customer SOC teams [inference].
- **Do not** implement anything that looks like evasion (unsigned loaders, process hollowing,
  disabling Defender, stripping MOTW) — those are the exact IOCs in the ScreenConnect abuse
  writeups [verified: same Forcepoint/Securityaffairs sources] [inference on the implication].
- Repo-specific: the CLAUDE.md rule "**never raise a UAC prompt unattended**" applies directly.
  The SYSTEM-in-console-session model means Swoop **never needs to elevate at runtime** —
  the service already has the privilege. Do not add a `runas` path [inference].

---

## APPENDIX: source list with dates

**Microsoft**
- Desktop Duplication API — https://learn.microsoft.com/en-us/windows/win32/direct3ddxgi/desktop-dup-api (ms.date 2018-05-31, updated 2025-04-15)
- Screen capture (WGC) — https://learn.microsoft.com/en-us/windows/apps/develop/media-authoring-processing/screen-capture (ms.date 2026-08-23)
- GraphicsCaptureSession.IsBorderRequired — https://learn.microsoft.com/en-us/uwp/api/windows.graphics.capture.graphicscapturesession.isborderrequired (updated 2026-07-23)
- GraphicsCaptureSession.IsCursorCaptureEnabled — https://learn.microsoft.com/en-us/uwp/api/windows.graphics.capture.graphicscapturesession.iscursorcaptureenabled?view=winrt-19041
- Loopback Recording — https://learn.microsoft.com/en-us/windows/win32/coreaudio/loopback-recording
- Using the Clipboard / Clipboard Operations — https://learn.microsoft.com/en-us/windows/win32/dataxchg/using-the-clipboard , .../clipboard-operations
- Old New Thing, delay-rendered clipboard timeout — https://devblogs.microsoft.com/oldnewthing/20220609-00/?p=106731 (2022-06-09)
- CreateSyntheticPointerDevice / InjectSyntheticPointerInput — https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-createsyntheticpointerdevice , .../nf-winuser-injectsyntheticpointerinput
- OpenInputDesktop — https://learn.microsoft.com/en-us/windows/desktop/api/winuser/nf-winuser-openinputdesktop
- WTSGetActiveConsoleSessionId / CreateProcessAsUserW — https://learn.microsoft.com/en-us/windows/desktop/api/Winbase/nf-winbase-wtsgetactiveconsolesessionid , https://learn.microsoft.com/en-us/windows/win32/api/processthreadsapi/nf-processthreadsapi-createprocessasuserw
- UAC uiAccess secure-location policy — https://learn.microsoft.com/en-us/previous-versions/windows/it-pro/windows-10/security/threat-protection/security-policy-settings/user-account-control-only-elevate-uiaccess-applications-that-are-installed-in-secure-locations
- SendSAS Step by Step — https://learn.microsoft.com/en-us/archive/blogs/technet/itasupport/sendsas-step-by-step
- IddCx overview — https://learn.microsoft.com/en-us/windows-hardware/drivers/display/indirect-display-driver-model-overview
- Attestation signing — https://learn.microsoft.com/en-us/windows-hardware/drivers/dashboard/code-signing-attestation
- SmartScreen reputation — https://learn.microsoft.com/en-us/windows/apps/package-and-deploy/smartscreen-reputation
- Edge WebRTC H.265 not sent — https://learn.microsoft.com/en-us/answers/questions/5880331/h-265-hevc-not-published-sent-via-webrtc-chrome-su
- Session 0 / interactive services removal — https://learn.microsoft.com/en-us/answers/questions/27517/is-there-any-workaround-in-win10-to-allow-service
- Signed malware / RMM backdoors — https://www.microsoft.com/en-us/security/blog/2026/03/03/signed-malware-impersonating-workplace-apps-deploys-rmm-backdoors/ (2026-03-03)

**NVIDIA / AMD / Intel**
- NVENC Video Encoder API Programming Guide 13.0 — https://docs.nvidia.com/video-technologies/video-codec-sdk/13.0/nvenc-video-encoder-api-prog-guide/index.html
- Video Encode/Decode GPU Support Matrix — https://developer.nvidia.com/video-encode-and-decode-gpu-support-matrix-new (read 2026-09-17; 12 concurrent sessions)
- NVENC D3D11 buffer formats — https://forums.developer.nvidia.com/t/video-codec-buffer-formats-supported-w-d3d11/210169
- NVENC YUV444 from ARGB — https://forums.developer.nvidia.com/t/nvenc-yuv444-from-argb-format/189415
- NVENC under GPU load — https://forums.developer.nvidia.com/t/running-gpu-heavy-tasks-significantly-decrease-nvenc-performance/50674
- AMF Video Encode API — https://github.com/GPUOpen-LibrariesAndSDKs/AMF/blob/master/amf/doc/AMF_Video_Encode_API.md
- Intel VPL Encoding Procedures — https://intel.github.io/libvpl/latest/programming_guide/VPL_prg_encoding.html
- Intel VPL VPP structures — https://intel.github.io/libvpl/latest/API_ref/VPL_structs_vpp.html

**Academic**
- Evaluation of NVENC Split-Frame Encoding (SFE) for UHD — https://arxiv.org/abs/2511.18687 (Nov 2025)
- Evaluation of GPU Video Encoder for Low-Latency Real-Time 4K UHD — https://arxiv.org/pdf/2511.18688
- Evolution of NVENC Efficiency (HQ/UHQ tuning, latency, energy) — https://arxiv.org/html/2605.01187v1
- 10-bit 4:2:2 + SFE for V-PCC (4-NVENC Blackwell) — https://arxiv.org/html/2606.29179

**WebRTC**
- Intent to Ship: H265 in WebRTC — https://groups.google.com/a/chromium.org/g/blink-dev/c/3h8lL8a377c (2025-03-03, M136)
- Chrome Platform Status feature — https://chromestatus.com/feature/5153479456456704
- Video coding in WebRTC (encoder factories) — https://chromium.googlesource.com/external/webrtc/+/master/modules/video_coding/g3doc/index.md
- Sending pre-encoded H.264 via native WebRTC — https://groups.google.com/g/discuss-webrtc/c/8DC2iF0eP6s
- libdatachannel README + DOC.md — https://github.com/paullouisageneau/libdatachannel
- libdatachannel BWE discussion #505 — https://github.com/paullouisageneau/libdatachannel/discussions/505 (2021-10-12/13)
- libdatachannel Relay Server over TCP issue #30 — https://github.com/paullouisageneau/libdatachannel/issues/30
- str0m README — https://github.com/algesten/str0m
- webrtc-rs v0.17.0 feature freeze — https://webrtc.rs/blog/2026/01/31/webrtc-v0.17.0-feature-freeze-sansio-shift.html (2026-01-31)
- webrtc-rs v0.20.0 — https://webrtc.rs/blog/2026/07/31/announcing-webrtc-v0.20.0.html (2026-07-31)
- webrtc-rs H265 packetizer issue #779 — https://github.com/webrtc-rs/webrtc/issues/779 (2026-03-01)
- Pion HEVC broken issue #3137 — https://github.com/pion/webrtc/issues/3137
- LiveKit rust-sdks (Developer Preview) — https://github.com/livekit/rust-sdks
- GStreamer webrtcsink — https://gstreamer.freedesktop.org/documentation/rswebrtc/webrtcsink.html
- GStreamer d3d11screencapturesrc — https://gstreamer.freedesktop.org/documentation/d3d11/d3d11screencapturesrc.html
- GStreamer nvd3d11h265enc — https://gstreamer.freedesktop.org/documentation/nvcodec/nvd3d11h265enc.html
- d3d11screencapturesrc in a Windows service — https://discourse.gstreamer.org/t/cannot-initialize-d3d11screencapturesrc-in-a-windows-service/1780 (2024-06-19 / 2024-07-01)
- W3C WebRTC-SVC — https://www.w3.org/TR/webrtc-svc/
- mDNS ICE candidates — https://bloggeek.me/psa-mdns-and-local-ice-candidates-are-coming/ , https://datatracker.ietf.org/doc/html/draft-ietf-mmusic-mdns-ice-candidates-03
- Simulcast/PLI fan-out cost — https://getstream.io/blog/simulcast-video-call-bandwidth/
- AV1 for WebRTC / SCC — https://visionular.ai/av1-for-webrtc/
- WebRTC browser support 2026 — https://antmedia.io/webrtc-browser-support/

**Products / projects**
- Sunshine capture architecture — https://deepwiki.com/LizardByte/Sunshine/5.1-video-capture , .../5.3-platform-specific-capture-implementations
- Sunshine network architecture (ENet/RTSP/UDP) — https://deepwiki.com/LizardByte/Sunshine/4-core-streaming-architecture , .../4.4-udp-streaming-and-data-plane
- Sunshine service/Job Object — https://deepwiki.com/qiin2333/foundation-sunshine/12.3-service-installation , https://github.com/loki-47-6F-64/sunshine/pull/137
- Sunshine WGC-in-service issue #2846 — https://github.com/LizardByte/Sunshine/issues/2846 (2024-07-13)
- Sunshine multi-client issues — https://github.com/LizardByte/Sunshine/issues/795 , /3887
- Sunshine 24H2 black screen — https://github.com/LizardByte/Sunshine/issues/3995
- Sunshine changes refresh rate of unused displays — https://github.com/LizardByte/Sunshine/issues/3591
- Sunshine display_wgc.cpp — https://docs.lizardbyte.dev/projects/sunshine/latest/display__wgc_8cpp.html
- RustDesk capture/encode — https://deepwiki.com/rustdesk/rustdesk/5.1-video-capture-and-encoding
- RustDesk hwcodec (D3D11VA not CUDA) — https://deepwiki.com/rustdesk-org/hwcodec
- RustDesk DXGI access-loss recovery PR — https://github.com/rustdesk/rustdesk/pull/16024
- Looking Glass SetThreadDesktop for UAC — https://github.com/gnif/LookingGlass/issues/263
- TailVNC desktop-following — https://github.com/wh0amitz/TailVNC
- parsec-vdd — https://github.com/nomi-san/parsec-vdd
- SudoVDA — https://github.com/SudoMaker/SudoVDA
- Virtual-Display-Driver — https://github.com/VirtualDrivers/Virtual-Display-Driver (+ issue /382)
- Apollo — https://github.com/ClassicOldSong/Apollo
- Parsec max client connections — https://support.parsec.app/hc/en-us/articles/32361376782228-Max-Client-Connections-To-Your-Host
- Parsec hardware/software compatibility (4:4:4) — https://support.parsec.app/hc/en-us/articles/32381568346644-Hardware-and-Software-Compatibility
- Parsec Warp — https://parsec.app/warp
- Parsec networking protocol blog — https://parsec.app/blog/a-networking-protocol-built-for-the-lowest-latency-interactive-game-streaming-1fd5a03a6007
- OBS WGC vs DXGI — https://obsproject.com/forum/threads/windows-graphics-capture-vs-dxgi-desktop-duplication.149320/
- OBS NVENC GPU cost — https://obsproject.com/forum/threads/nvenc-actually-uses-a-lot-of-gpu-resources-and-watts.154685/
- OBS advanced NVENC options — https://obsproject.com/kb/advanced-nvenc-options
- Lossless Scaling DXGI vs WGC FAQ — https://sageinfinity.github.io/docs/FAQ/dxgiwgc
- ForceComposedFlip — https://github.com/fernandoenzo/ForceComposedFlip
- pinray (windows crate: DXGI/WGC/WASAPI) — https://github.com/Itz-Agasta/pinray
- win_desktop_duplication crate — https://crates.io/crates/win_desktop_duplication
- StaZhu HEVC in Chromium (RExt matrix) — https://github.com/StaZhu/enable-chromium-hevc-hardware-decoding
- Fluendo remote-desktop codec benchmark — https://fluendo.com/blog/benchmarking-remote-desktop-coding-tools-for-daas-and-vdi/
- Streaming Learning Center, low-latency transcoding quality cost — https://streaminglearningcenter.com/codecs/the-quality-cost-of-low-latency-transcoding.html
- Opus FAQ / encoder CTLs — https://wiki.xiph.org/OpusFAQ , https://opus-codec.org/docs/opus_api-1.5/group__opus__encoderctls.html
- Opus DTX — https://getstream.io/resources/projects/webrtc/advanced/dtx/
- Project Zero, UIPI/uiAccess bypass — https://projectzero.google/2026/02/windows-administrator-protection.html (2026-02)
- headless-display-fix — https://github.com/jonnyck-dev/headless-display-fix
- NVENC Wikipedia (resolution caps) — https://en.wikipedia.org/wiki/Nvidia_NVENC
- Tom's Hardware / VideoCardz NVENC session limits — https://www.tomshardware.com/news/nvidia-increases-concurrent-nvenc-sessions-on-consumer-gpus , https://videocardz.com/newz/nvdia-geforce-gpus-now-support-up-to-8-concurrent-nvenc-encoding-sessions

---

## THINGS I COULD NOT VERIFY

1. **A rigorous WGC-vs-DDA latency benchmark.** Only qualitative claims ("slightly more
   overhead, usually negligible"). Measure on your own hardware.
2. **Whether WebRTC (as opposed to `<video>`/WebCodecs) negotiates HEVC RExt 4:4:4 in Chrome.**
   Assume no.
3. **Whether AMF accepts a BGRA D3D11 texture directly** or always needs a conversion stage.
   The AMF doc does not say.
4. **Firefox WebRTC HEVC status.** No evidence of support found either way.
5. **Whether `IsBorderRequired = false` can be pre-granted for an unattended fleet machine**
   (e.g. via a provisioned MSIX capability + a pre-recorded consent). The docs describe only
   the interactive prompt.
6. **Parsec's actual internal multi-guest encoder topology.** Inferred from the shared-bitrate
   support article, not confirmed.
7. **Sub-3 ms WASAPI loopback.** Only found as an aspirational feature request.
8. **Exact NVENC end-to-end latency on a GPU-saturated TouchDesigner box.** The 200fps→60fps /
   10ms→30ms datapoint is a 2017-era forum report; re-measure on current hardware.
9. **libdatachannel's current TWCC status.** The maintainer's "not implemented for now" is from
   2021-10-12; I found no evidence it has changed, but I could not confirm the 2026 state
   from a dated source.
