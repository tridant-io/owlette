# swoop on macOS: 4K at 60, and one keyboard model

Written 2026-10-01 from gate M1's findings (`../swoop-macos/spikes/6.1-first-mac-picture.md`). Two problems the
owner named: "mac looks super blurry at HD res … 4K is tenable, especially on a LAN and h265", and "think deep
about keyboard bindings between macOS and Windows, bidirectionally … windows key becomes command".

## Part 1: the picture

### What was measured (the rig, MacBook Air, Apple silicon, HEVC hardware, 3420x2214, 240 frames)

| rate control | frames submitted without waiting | paced at 60 Hz | submit → callback |
| --- | --- | --- | --- |
| low-latency on (what ships) | 48.6 fps ceiling; each submit blocks 20 ms | 48.5 fps | 100 ms p50 |
| low-latency off | 104 fps | **60.0 fps, none dropped** | **11 ms p50, 14–17 ms p95** |

Earlier in the same run: at 1668x1080, low-latency off encodes in 3.2 ms against 6.8 ms on. Neither a looser
`DataRateLimits` window nor `MaxAllowedFrameQP` changed a moving frame's size; with low-latency on, moving frames
got about 2.4 times their share of the rate whatever was set.

### Why it is blurry and smears today

- Capturing at the display's size in points (`adf65040`) halved the pixels so the shipped encoder could keep up.
  A Retina Mac renders text at 2x; shown at 1x it is soft, and a Windows host never goes through that.
- VideoToolbox's low-latency rate control is the wrong mode for this size: it serialises the encoder (one frame
  at a time, 20 ms each) and tops out under 50 fps. Its name promised the opposite, which is why it was chosen.
- The capture loop waits on every encode (`VTCompressionSessionCompleteFrames` per frame), so encode time is
  subtracted from the frame interval. At 11 ms that alone would hold 60 only just; at 24 ms it cannot.

### The route

1. **Encoder:** open the session without `EnableLowLatencyRateControl` on macOS (keep `RealTime`, no
   reordering, the forced keyframes, `AverageBitRate`; `DataRateLimits` where the session takes it). Stop
   completing each frame: VideoToolbox's output callback already runs on its own thread and already carries the
   capture ticks, so it hands finished frames to the session itself. The `Encoder` contract already allows
   `Ok(None)` ("an encoder running asynchronously has not produced output for this input yet"); what it lacks is
   a way for output to arrive later than a call. The smallest addition is a sink the session gives an encoder at
   open (`fn set_sink(&mut self, sink: Box<dyn Fn(EncodedFrame) + Send>)`, default no-op), which the VideoToolbox
   backend calls from its callback and every Windows backend ignores. The session's per-tier `force_irap` clears
   on a submit the backend accepted, not on a returned frame, or a sink backend forces a keyframe forever.
2. **Capture:** back to the display's pixel rect (revert the point-size capture of `adf65040` and the picture
   grid of `2cfbef4a`; the cursor is drawn at the panel's scale and reported in pixels again). `native` means
   Retina. The menu's 1440p and 1080p rungs go through the VideoToolbox pixel transfer the tiers already own.
3. **Rate:** `auto` is 20 Mbps, measured for 1080p-class Windows hosts. A source above 2.5 megapixels starts
   at 50 Mbps (the menu's top); the governor still descends on loss, so a relayed path pays nothing new. The
   settle keyframe (`404640ec`) stays unless the 4K run shows it is not needed.
4. **Verify** on the rig and in a session: the hardware test prints paced-60 throughput and latency at the panel's
   size; the stats overlay shows the frame rate and the capture-to-display breakdown; window drags at 4K; then
   the four Windows commands and one Windows session, because the `Encoder` contract moved.

What this does not do: change any Windows backend's behaviour, or the Linux stub.

## Part 2: the keyboard

### The model: keys match keys, and shortcuts are a switch on top

The browser already names every key by its physical identity (`code`): `MetaLeft` is the Windows key on a PC
and Command on a Mac, `AltLeft` is Alt and Option, `ControlLeft` is Ctrl and Control. macOS itself treats a PC
keyboard that way (Windows key is Command, Alt is Option). So the base layer, in both directions and with nothing
to configure, is identity: **the Windows key is Command, Alt is Option, Ctrl is Control**, from a PC to a Mac
and from a Mac to a PC. That is the owner's rule, and the wire already carries it: today a Mac host receives
`MetaLeft` as Command.

What stops it working is the viewer's own machine, not the mapping. Outside keyboard lock, Windows takes the
Windows key for itself (Start, Win+L, Win+D), and a Mac browser takes Cmd+W, Cmd+T, Cmd+Q. Keyboard lock is
Chromium's, needs fullscreen, and **Brave switches the API off** (`web/lib/swoop/keyboardLock.ts`). So the
owner's Brave sessions can never deliver the Windows key; Chrome or Edge in fullscreen can.

Hence the one switch the keyboard menu has, "ctrl acts as cmd" (PC viewer, Mac host) or "cmd acts as ctrl"
(Mac viewer, Windows host): it exists so copy, paste, undo and save work from muscle memory in every browser,
including those where the super key can never arrive. It stays the default. Off, keys match keys. In both
settings the Windows key is Command and Command is the Windows key: the switch never changes that.

| PC viewer, Mac host | default ("ctrl acts as cmd") | off (keys match) |
| --- | --- | --- |
| Ctrl | Command | Control |
| Windows key | Command (needs keyboard lock) | Command (needs keyboard lock) |
| Alt | Option | Option |

| Mac viewer, Windows host | default ("cmd acts as ctrl") | off (keys match) |
| --- | --- | --- |
| Command | Ctrl | Windows key (needs keyboard lock) |
| Control | Ctrl | Ctrl |
| Option | Alt | Alt |

Mac to Mac and PC to PC are identity with no switch. Linux hosts behave as Windows hosts.

### What was actually broken at M1

"ctrl-c-v definitely not working" was most likely not the mapping. On a paste the viewer first pushes the PC's
clipboard to the host, then sends the keystroke. A Windows host syncs every copy back to the PC first, so the
push carries the same text and nothing is lost. A Mac host reads its pasteboard only when owlette is on *allow*
under System Settings › Privacy & Security › Paste from Other Apps (anything else raises macOS's paste alert at
whoever is at the Mac, so the streamer does not read). Without that, a copy on the Mac never reaches the PC, and
the next Ctrl+V pushes the PC's **stale** clipboard over the Mac's fresh one before pasting it. Two fixes, both
directions, every host:

- the viewer never re-pushes a clip the host already has: it skips the push when the PC clipboard is unchanged
  since the last push or since the last clip the host sent;
- the Mac's pasteboard access behaviour goes to the service log at info at session start, and the clipboard
  feature's status tells the viewer when the host cannot read its clipboard, so the toolbar can say so instead of
  pasting the wrong thing silently.

### Also

A legend in the keyboard menu: three rows for this host, this viewer and the current switch, as the tables
above, so nobody has to ask what a key does. And one table-driven test over every host × viewer × switch, so the
model is checked in both directions rather than remembered.

## Owner decisions

1. **The shortcut switch stays the default** (copy and paste work in every browser; keys-match is one click
   away). Proposed; the owner may prefer keys-match as the default for Chrome users.
2. **`native` on a Mac is Retina again, at 50 Mbps auto for 4K-class sources.** Proposed per "4K is tenable".
3. **The Windows-key path is tested in Chrome**, since Brave cannot deliver it. The owner's call which browser
   the fleet is expected on.
4. The pasteboard setting on the rig Mac: *allow*, or the Mac's copies stay on the Mac by design.

## Risks

- One frame in flight adds up to a frame of latency at 60 Hz; measured 11 ms p50 at the panel's size, against
  the 100 ms the shipped mode showed once pipelined.
- Without low-latency rate control the session refused `MaxFrameDelayCount` too; reordering off is what keeps
  decode order equal to input order. The SPS rewrite path for H.264 stays.
- 50 Mbps on Wi-Fi: the governor descends on loss as it does today; nothing in this plan changes its floor.
