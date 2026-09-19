# swoop wire protocol

**protocol version 1** · status: contract · owner: `agent/swoop`

this file is the wire contract between the owlette api, the signaling worker, `owlette-swoop.exe` and the
browser. every later task is built against it. the golden vectors in [`testdata/protocol/`](testdata/protocol/)
are the executable half: `testdata/protocol/index.json` lists every one with the verdict it must produce, and
both the web protocol library and the rust protocol core iterate that list.

normative words (MUST, MUST NOT, SHOULD) mean what they say. [section 11](#11-security) is pasted verbatim
from the threat model and its literals are load-bearing — a drifted salt or info string is a silent interop
failure.

| section | |
|---|---|
| [1](#1-protocol-version-handshake) | protocol-version handshake |
| [2](#2-signaling-messages) | the ten signaling messages and per-role send rights |
| [3](#3-channeltrack-layout) | channel / track layout |
| [4](#4-binary-frame-header) | the binary frame header |
| [5](#5-input-cursor-clipboard-control-and-feedback-messages) | input, cursor, clipboard, control, feedback |
| [6](#6-the-stdinstdout-pipe-protocol) | the stdin/stdout pipe protocol and exit codes |
| [7](#7-the-bundle) | the bundle |
| [8](#8-jwt-claims) | jwt claims |
| [9](#9-the-host-fingerprint-mac) | the host fingerprint mac |
| [10](#10-lease-renewal) | lease renewal, the 12 h cap, and a missed renewal |
| [11](#11-security) | security |

---

## 1. protocol-version handshake

there is one integer, `SWOOP_PROTOCOL_VERSION = 1`. no minor version, no capability negotiation, no
`Accept:` header games. either both ends speak the same integer or they do not talk.

it is asserted in four places:

1. **the websocket subprotocol.** a browser dials the room with
   `Sec-WebSocket-Protocol: owlette.swoop.v1, jwt.<token>` and the worker echoes back only `owlette.swoop.v1`.
   the agent dials with `Authorization: Bearer <token>` and the same subprotocol. a worker that does not
   recognise the subprotocol refuses the upgrade.
2. **the `hello` frame.** the room's first frame to every socket carries `protocolVersion`. a client whose
   compiled-in version differs MUST send `bye` with `reason: "version_mismatch"`, close, and surface the
   mismatch to the user as "this machine needs an agent update" (or the reverse). it MUST NOT attempt to
   negotiate, downgrade or proceed.
   golden vectors: `handshake/handshake-hello-v1.json` (accept), `handshake/handshake-hello-v2.json` (reject).
3. **every data channel's `protocol` field** is `owlette.swoop.v1`. the host refuses a channel that offers
   anything else.
4. **the bundle.** `protocolVersion` and `agentVersion` are both in it. the streamer compares them against its
   own compiled-in constants and exits **11** on either mismatch — a stale exe after a delayed-until-reboot
   upgrade is exactly this case, and the agent refuses to spawn a streamer whose version differs from its own.

a version bump is a fleet event, not a patch. bumping it means the agent, the worker and the web app all ship
the new integer together, and old agents are refused until they upgrade.

---

## 2. signaling messages

ten message types travel over the signaling websocket. all are json objects with a `type`. the room stamps
`serverTimeMs` on everything it forwards and adds `from` and `fromRole` to anything a client sent.

the room is a dumb pipe. every authorisation decision was already made by the api before the token was minted;
the room only enforces who may send what, and to whom.

| type | may be sent by | delivered to |
|---|---|---|
| `hello` | **server only** | the socket that just joined |
| `ring` | **server only** (from `POST /v1/ring`) | doorbell sockets |
| `viewer-join` | **server only** | host and doorbell |
| `error` | **server only** | the offending socket |
| `kill` | **server only** (from `POST /v1/kill`) | every socket, then `close(1000)` |
| `offer` | viewer only | host and doorbell |
| `answer` | host only | the named viewer (`to`) |
| `host-ready` | host only | the named viewer, or all viewers when `to` is absent |
| `candidate` | viewer or host | viewer → host and doorbell; host → the named viewer, or all viewers |
| `bye` | viewer or host | same direction rule as `candidate` |

refusals, each an `error` frame carrying a code and nothing else:

- a client sending a server-only type → `forbidden_type`. a client cannot forge a ring or a kill.
- a client sending a type it is not the right role for → `wrong_role`.
- an unrecognised type → `unknown_type`; non-string frame → `binary_unsupported`; over 64 KiB →
  `message_too_large`; unparseable → `malformed_message`.

**a viewer never reaches another viewer.** the fan-out rule is directional: viewer traffic goes to the agent
side only, agent traffic goes to a named viewer or broadcasts to viewers.

**rooms are addressed from the verified token, never from the path.** the durable object is named
`${claims.site}:${claims.machine}`; a url that disagrees is refused `room_mismatch` (403).

fields, beyond `type`, `from`, `fromRole` and `serverTimeMs`:

- `hello`: `protocolVersion`, `role`, `id`, `sid`, `ctl`, `peers {doorbell, host, viewer}`
- `ring`: `sid`, `sentAtMs` — **and nothing else**, see section 11
- `viewer-join`: `viewer`, `sid`, `ctl`
- `offer` / `answer`: `sdp`; `answer` also carries `mac` (section 9) and `to`
- `host-ready`: `sid`, optional `to`
- `candidate`: `candidate`, `sdpMid`, `sdpMLineIndex`, optional `to`
- `kill`: `sid` (may be null — "kill whatever is running")
- `bye`: optional `reason`, optional `to`
- `error`: `code`

golden vectors: one per type in `testdata/protocol/signaling/`, plus `signal-viewer-sends-answer.json`
(`wrong_role`) and `signal-viewer-sends-kill.json` (`forbidden_type`).

keepalive: the room installs `setWebSocketAutoResponse('ping','pong')`. a browser, which cannot send a
protocol ping from javascript, sends the bare string `ping` and the runtime answers without waking the room.
the agent's doorbell uses protocol pings instead. neither is a protocol message and neither appears above.

---

## 3. channel/track layout

gate **G1 closed on 2026-09-18: the video path is an rtp media track rendered into a `<video>` element**
(bake-off arm B). the datachannel→webcodecs path and the `RTCRtpScriptTransform` path both lost and are
deferred. **video does not travel on a data channel.** the data channels carry input, cursor, clipboard,
control, feedback and per-frame metadata only.

one `RTCPeerConnection` per viewer. **the browser always offers, the host always answers**, and renegotiation
is always "the browser re-offers". the host never initiates an offer.

### media

| m-line | direction | notes |
|---|---|---|
| `video` | host → browser, `sendonly` / `recvonly` | h.265 main 8-bit 4:2:0 where both ends can, h.264 otherwise; chosen per viewer from the client capability probe ∩ host encoder availability |
| `audio` | host → browser, `sendonly` / `recvonly` | opus. **the browser always offers it** — it cannot know beforehand whether the host has an opus encoder. a host that does not answers the m-line with `port 0`, and that rejected line still carries the offer's format list, because rfc 4566's `media-field` is `1*(SP fmt)` and a browser discards the whole answer over an empty one |

the **playout-delay** header extension
(`http://www.webrtc.org/experiments/rtp-hdrext/playout-delay`) MUST be negotiated and MUST be set to
`min = 0`, `max ∈ (0, 500]` ms. **`max = 0` is forbidden**: it makes chrome fast-forward and spam PLI.

the browser attaches the track with `video.srcObject`. **never a blob url** — the app's csp has no `media-src`.

### data channels

all five are opened by the **browser** (it is the offerer), negotiated in-band, `protocol: "owlette.swoop.v1"`.

| label | ordered | reliability | direction | carries |
|---|---|---|---|---|
| `swoop-input` | false | `maxRetransmits: 0` | viewer → host | section 5 input |
| `swoop-cursor` | false | `maxRetransmits: 0` | host → viewer | section 5 cursor |
| `swoop-control` | true | reliable | both | section 5 control **and** clipboard |
| `swoop-feedback` | false | `maxPacketLifeTime: 250` | viewer → host | section 5 feedback |
| `swoop-meta` | false | `maxPacketLifeTime: 250` | host → viewer | section 4 records, binary |

clipboard shares `swoop-control` rather than taking a sixth channel because both are reliable, ordered and
rare, and because the transport caps buffering at 128 KiB **across all channels** — fewer channels is one
pacing budget instead of five competing ones. the clipboard caps and chunking in section 5 are what keep a
paste from starving that budget.

the host MUST refuse any channel whose label is not one of the five, and MUST NOT create a channel itself.

---

## 4. binary frame header

a fixed 48-byte record, **little-endian**, all fields naturally aligned. under the G1 winner it travels on
`swoop-meta` as a header-only record (`payloadBytes = 0`) and exists so the browser can join a presented frame
back to the host's per-stage timestamps — that is the instrumentation contract, and it is what the stats
overlay's per-stage breakdown is computed from. the fragment fields and the payload are defined here because
the same record prefixes an access unit on the deferred second video path; a task shipping arm B writes
`fragmentIndex = 0`, `fragmentCount = 1`, `payloadBytes = 0`.

| offset | size | field | type | meaning |
|---|---|---|---|---|
| 0 | 1 | `kind` | u8 | `0x01` = frame record. any other value → drop the message |
| 1 | 1 | `headerVersion` | u8 | `0x01`. a record with an unknown version is dropped, not guessed at |
| 2 | 1 | `codec` | u8 | `0` h264, `1` hevc, `2` av1 |
| 3 | 1 | `flags` | u8 | bit 0 `IRAP`, bit 1 `RESOLUTION_CHANGED`, bit 2 `PARAMETER_SETS_IN_BAND`; bits 3–7 reserved, sent zero |
| 4 | 2 | `fragmentIndex` | u16 | 0-based |
| 6 | 2 | `fragmentCount` | u16 | ≥ 1 |
| 8 | 4 | `frameId` | u32 | monotonic from 0 for the life of one track, no gaps, wraps at 2³² |
| 12 | 4 | `rtpTimestamp90k` | u32 | the rtp timestamp of the same picture on the video track — the join key |
| 16 | 2 | `width` | u16 | encoded luma width |
| 18 | 2 | `height` | u16 | encoded luma height |
| 20 | 4 | `payloadBytes` | u32 | access-unit size; `0` for a header-only record |
| 24 | 8 | `tCaptureUs` | u64 | capture: the compositor's present time for this desktop content |
| 32 | 8 | `tEncodeUs` | u64 | encode: the encoder signalled completion and the bitstream was locked |
| 40 | 8 | `tSendUs` | u64 | send: immediately before the frame was handed to the transport |
| 48 | … | payload | bytes | `payloadBytes` long, annex-b with start codes. empty under the G1 winner |

all three timestamps are **microseconds since `streamerEpoch`** (section 7), never raw performance-counter
ticks and never wall-clock. the browser converts to its own clock with the offset it measures on
`swoop-feedback`'s `ping`/`pong`, so no end has to trust the other's clock.

### never a chunk with a dangling reference

a receiver MUST NOT hand a decoder a chunk whose references it did not receive. chrome hard-fails h.265 on a
missing prior slice, and the failure is a black stream, not a dropped frame.

- a sender MUST set `IRAP` on any record whose `frameId` is not `previousFrameId + 1` for that track. a gap
  without `IRAP` **is** the dangling reference.
- a receiver that sees a `frameId` gap, a decoder error, or `RESOLUTION_CHANGED` MUST drop everything until
  the next record with `IRAP` set and request an idr on `swoop-control`. it MUST NOT reorder, MUST NOT
  interpolate, and MUST NOT submit the gap-crossing chunk "to see if it decodes".
- a resolution change is always a new idr **plus** a decoder reconfigure; chromium rejects a non-irap h.265
  config change outright.
- `PARAMETER_SETS_IN_BAND` is set on every irap, because vps/sps/pps go in-band with every irap.

idr requests are rate-limited by the host with a 250–500 ms cooldown; a receiver may ask as often as it likes
and the host coalesces.

golden vectors: `frame/frame-key-1080p.bin`, `frame/frame-delta-fragmented.bin`, and the negative
`frame/frame-dangling-reference.bin` (`frameId` 42 → 45 with `IRAP` clear). each index entry carries the
expected decode and the receiver state the vector is evaluated against.

---

## 5. input, cursor, clipboard, control and feedback messages

json objects, one per message, on the channels in section 3. every message has a short `t`. viewer→host
messages carry `seq` (monotonic per channel, for de-duplication after a reconnect) and `tsUs` (the viewer's
clock, used only for latency accounting — never for authorisation).

**control gating.** the host enforces `ctl` from the **verified jwt**, never from anything the browser says
about itself, and never from the bundle alone. `ctl` in the bundle is a floor: `"ctl": false` makes the
streamer refuse control for the whole session regardless of what a viewer token claims. a viewer without
`ctl` that sends anything gated below is dropped and the attempt is reported to
`POST /api/agent/swoop/events`.

**how a refusal reaches that route.** the streamer holds no long-lived credential (§8), so every row it wants
in the audit trail leaves as a `host_event` line on stdout (§6) and the **service** posts it with the
machine's own token. the line's `kind` is that route's closed vocabulary; its `reason` is the finer code the
refusing module already owns (`unknown_kid`, `join_too_soon`, `fp_missing`), and the route refuses anything
outside `^[a-z0-9_]{1,48}$`. a refusal is reported **once per viewer**, not once per message — a watcher
holding a key down repeats at 30 Hz — and the count of everything suppressed behind that one line rides
`status.denials`.

### input — `swoop-input`, viewer → host, requires `ctl`

| `t` | fields |
|---|---|
| `k` | `code` (a `KeyboardEvent.code`), `down` |
| `m` | `x`, `y` — absolute, normalised `0..1` of the **selected display** |
| `mr` | `dx`, `dy` — relative, from pointer lock with `unadjustedMovement` |
| `b` | `button` (0 left, 1 middle, 2 right, 3 x1, 4 x2), `down` |
| `w` | `dx`, `dy`, `mode` (`"pixel"` \| `"line"` \| `"page"`) |

the host maps `code` through [`testdata/keymap.json`](testdata/keymap.json) to a ps/2 set-1 scancode plus an
extended flag. **the host keys on `code` and never on `key`**: the numpad and the control/arrow pad share
scancode low bytes and are told apart only by `extended`. left and right modifiers stay distinct on the wire.
a mac client maps cmd → `ControlLeft` **in the browser**, before it sends, so the host never guesses.
`PrintScreen` and `Pause` are sequences, not single scancodes; keymap.json's `sequences` object holds them.

### cursor — `swoop-cursor`, host → viewer

| `t` | fields |
|---|---|
| `cpos` | `x`, `y` normalised, `visible`, `tsUs` |
| `cshape` | `id`, and on first use `hotX`, `hotY`, `w`, `h`, `png` (base64) |
| `vpos` | `viewer`, `x`, `y` normalised, `tsUs` — where **another** controller's pointer is |

shapes are cached by `id`; a repeat is `{"t":"cshape","id":n}` alone. css cursors above 128×128 are silently
ignored by browsers, so a shape larger than 32×32 css px is presented as an overlay instead.

`cpos` is the **machine's own** pointer, which is one thing however many people are watching. `vpos` is where
each *other* controller is pointing, so a session with more than one controller can draw them — the host
publishes one per absolute `m` it accepts, from the viewer it accepted it from, and never for the viewer it
is being sent to. a viewer in pointer lock sends `mr` deltas and has no position of its own, so it publishes
no `vpos` at all; `cpos` is where that pointer went. a viewer draws `vpos` as an overlay element and leaves
its own cursor a css cursor.

### clipboard — `swoop-control`, both directions, host→viewer ungated, viewer→host requires `ctl`

`{"t":"clip","dir":"to-host"|"to-viewer","fmt":"text"|"png","seq":n,"chunk":i,"chunks":k,"totalBytes":n,"data":"<base64>"}`

- caps: text ≤ 256 KiB, image ≤ 2 MiB, one chunk ≤ 16 KiB. `totalBytes` is checked **before the first chunk
  is buffered** — a receiver that waits until reassembly to notice the size has already paid for it.
  over cap → drop the whole transfer, reason `clipboard_too_large`.
- file lists are never carried. there is no file transfer in this protocol.
- transfers above 64 KiB are reported to `POST /api/agent/swoop/events` for the audit trail, as a
  `host_event` with `kind: "clipboard_audit"`. the content never is.

### control — `swoop-control`, both directions

viewer → host: `quality` (`preset`, `maxBitrateKbps`, `maxFps` — per viewer, allowed for watchers),
`display` (`index` — shared state, requires `ctl`), `idr`, `sas` (ctrl+alt+del, requires `ctl`),
`mute` (`on`), `lease` (`token`, section 10).

host → viewer: `hello-host` (`codec`, `width`, `height`, `displays[]`, `streamerEpoch`, `protocolVersion`),
`sas-result` (`ok`), `lease-ok` (`expiresAt`), `ended` (`reason`), `roster` (`viewers[]` of
`{id, name, ctl}`, `tsUs`).

`roster` is who is connected and who holds control, sent **whole on every change** rather than as a delta —
this channel is ordered and reliable, but a viewer that joined late has no earlier state to apply a delta to.
it carries no token, no fingerprint and no lease: a line is an id, a name and a boolean. `ctl` on it is the
host's own verdict from each viewer's verified jwt, which is what makes it worth showing; `name` is that
token's `uid` where it carries one and the viewer id otherwise, because §8's claim set has no name in it.

### feedback — `swoop-feedback`, viewer → host

| `t` | fields |
|---|---|
| `fb` | `frameId`, `tArrivalUs`, `tDecodeUs`, `tPresentUs`, `clockOffsetUs` — sampled, not every frame |
| `stats` | `decodeQueue`, `framesDropped`, `jitterMs`, `rttMs`, `widthCss`, `heightCss` — once a second |
| `ping` | `id`, `tUs`; the host answers `pong` with `id`, `tUs` echoed, and its own `hostUs` |

`ping`/`pong` is the app-level round trip, and its one-way half is the offset that makes section 4's
timestamps comparable across the two clocks. feedback drives the rate governor: bitrate, fps and resolution.

golden vectors: `messages/msg-input-batch.json`, `messages/msg-input-no-ctl.json` (reject, `not_permitted`),
`messages/msg-cursor.json`, `messages/msg-clipboard-text.json`, `messages/msg-clipboard-oversize.json`
(reject, `clipboard_too_large`), `messages/msg-control.json`, `messages/msg-feedback.json`.

---

## 6. the stdin/stdout pipe protocol

the service spawns `owlette-swoop.exe run` with its own system token retargeted to the console session, over
**inherited anonymous pipes**. there are no files between the service and the streamer, and nothing sensitive
is ever on a command line.

### stdin, service → streamer

**line 1 is the bundle**: one json object, one line, utf-8, no bom, terminated by `\n`. every line after it is
a control line:

- `{"type":"kill"}` — end the session and exit 0.
- `{"type":"sas_result","ok":true}` — the answer to a `sas_request`; the service, not the streamer, calls
  `SendSAS`. the streamer routes it to whichever feature raised that `sas_request` and to nothing else; an
  answer to a question nobody put is dropped with a log line. `"ok": false` means the service could not
  raise the sequence at all.

**eof on stdin means the service is gone.** the streamer tears the session down and exits 0. it does not try
to carry on, and it does not try to reach the service any other way.

### stdout, streamer → service

json lines, one object per line, drained on a daemon thread so nothing ever blocks the service's five-second
loop.

| event | fields |
|---|---|
| `ready` | `sid`, `pid`, `version`, `protocolVersion`, `codecs[]`, `displays` |
| `viewer_joined` | `sid`, `viewer`, `ctl`, `codec` |
| `viewer_left` | `sid`, `viewer`, `reason` (`bye` \| `timeout` \| `lease_expired` \| `kill`) |
| `sas_request` | `sid`, `viewer` |
| `host_event` | `sid`, `kind`, `viewer` (optional), `reason` (optional) |
| `status` | `sid`, `viewers`, `controllers`, `indicator`, `bitrateKbps`, `fps`, `path` (`direct` \| `relay`), `display`, `uptimeS`, and the optional fields below |
| `exiting` | `sid`, `code`, `reason` (`idle` \| `kill` \| `signal_lost` \| `session_cap` \| `error`) |

`host_event` is one row for `POST /api/agent/swoop/events`, which the service posts on the streamer's behalf
(§5). `kind` is that route's own closed vocabulary — `jwt_rejected`, `fp_mismatch`, `lease_expired`,
`input_not_permitted`, `join_refused`, `clipboard_audit` — so a name added here has to be added there too, or
the route answers 400 for the whole batch. `viewer` is absent when the refusal is not attributable to one.

`status` carries fourteen **optional** fields, each omitted when it has nothing to say: a session whose
features are all quiet and whose peer is down emits exactly the nine-field line above, which is what the
golden vector holds.

| field | meaning |
|---|---|
| `desktop` | the input desktop: `default` \| `winlogon` \| `screensaver` \| `unknown`. an `OpenInputDesktop` that failed is `unknown` and is **never** reported as a lock. |
| `audio` | the render endpoint: `ok` \| `no_endpoint`. swoop never creates a device and never moves the default. |
| `displays` | `ok` \| `headless` — headless is no attached output, or a duplication that yields nothing but black. |
| `inputDropped` | the input rate limiter's cumulative drop count. **absent means zero**, not unknown. |
| `denials` | the control gate's cumulative refusals, including every one suppressed behind a single `host_event`. absent means zero. |
| `testOverride` | the bundle's test-only `overrides`, named so an overridden session cannot pass for a real one in `logs/swoop`. absent on every release build, which refuses such a bundle with exit 10. |
| `idrs` | keyframes the host actually forced since `ready`, **after** section 4's coalescing — not the number of requests, which a receiver in a loss storm raises on every record. absent means zero. |
| `encoder` | which backend of the fallback chain the session is encoding on: `nvenc` \| `qsv` \| `amf` \| `mf` \| `openh264`. absent until a viewer's offer has named a codec and the first encoder is open, and absent again once the last viewer leaves — the pause closes the encoder with the duplication. `ready`'s `codecs[]` says what the machine *can* do; this says what it did. |

the five below are the rate governor's, and they ride a `status` **only while a viewer's peer is connected**:
with nobody watching there is no rate being governed, `bitrateKbps` and `fps` are already zero, and the
nine-field line is what a quiet session promises.

| field | meaning |
|---|---|
| `preset` | the quality ceiling in force, as one word: `auto`, or `<n>mbps/<resolution>/<n>fps`. it is *rendered* from the ceiling's three numbers and never parsed back — section 5's `quality` is the only thing that sets them. |
| `targetKbps` | what the governor is aiming at, against `bitrateKbps`, which is what actually went out. the pair is the point: a target the link never delivered is invisible from either number alone. |
| `rungFps` | the quality ladder's current frame-rate rung. it is a **capture-side** cap — the encoder is never told — so it is not the same number as `fps`, which is measured. |
| `rungResolution` | that rung's resolution cap, in `quality.preset`'s own spelling (`native` \| `1440p` \| `1080p` \| `720p`). |
| `rungIndex` | how far down the preset's ladder that rung is. absent means zero, the preset's own rung, which is where a healthy session sits. |
| `governor` | `ceiling` (at the preset with nothing to answer) \| `holding` (inside the 2 s hold after a cut) \| `climbing` \| `pinned` (at the floor — every further degraded window is answered by the ladder, or by nothing). |

`display` names the output being captured, in the same numbering `hello-host`'s `displays[]` uses.

stderr is free text and goes to `logs/swoop/`, which the streamer rotates itself under a size cap. **the
bundle never appears on stdout, on stderr, in a log, or in an error message — not at debug, not partially.**

### exit codes

| code | meaning |
|---|---|
| 0 | normal exit: killed, idle-timed-out, or stdin closed |
| 10 | bundle invalid — malformed, missing a required field, or carrying `overrides` without the `testhooks` build |
| 11 | version mismatch — `protocolVersion` or `agentVersion` differs from this binary |
| 12 | no capture source |
| 13 | no encoder |
| 14 | signaling unreachable |
| 20 | internal error |

one streamer per machine serves every viewer, lingers about 60 s after the last one leaves, then exits 0.

golden vectors: `pipe/pipe-stdout-events.ndjson`, `pipe/pipe-stdin-control.ndjson`. there is deliberately no
golden vector containing a real bundle line; the bundle vectors in section 7 are all fake. the stdout vector
is a **clean** session, so neither `host_event` nor any of `status`'s optional fields appears in it — a build
that started emitting one of those unasked would change every line of that file, which is exactly what the
vector is there to catch.

---

## 7. the bundle

**the bundle is never logged.** not at debug, not partially, not in an error's `Display` or `Debug` output. in
rust every secret field is wrapped in `zeroize` and wiped on drop.

the agent fetches it from `POST /api/agent/swoop/bundle` over its own authenticated channel and hands it to the
streamer as line 1 of stdin. it is never written to disk, never passed on a command line, and **never carried
in a firestore command document** — see section 11.

```jsonc
{
  "protocolVersion": 1,
  "agentVersion": "3.4.0",
  "sid": "sid_…",                  // one streamer lifetime on one machine
  "site": "site_…",
  "machine": "machine_…",
  "now": 1789344000,               // the time anchor: unix seconds, the api's own clock at mint
  "streamerEpoch": 1789344000000000, // unix microseconds; section 4's timestamps are relative to this
  "signalUrl": "wss://…/v1/room/{site}/{machine}",
  "hostToken": "<host jwt, aud=swoop-signal, role=host>",
  "jwtKeys": [                     // current and previous, for the two-key overlap
    { "kid": "…", "alg": "EdDSA", "key": "<base64url raw 32-byte ed25519 public key>" }
  ],
  "sessionKey": "<base64url 32 bytes>",  // K_session for this sid
  "iceServers": [ { "urls": ["stun:…"] }, { "urls": ["turn:…"], "username": "…", "credential": "…" } ],
  "enablement": {
    "membersMayWatch": true,
    "maxViewers": 4,
    "leaseSeconds": 300,
    "sessionCapSeconds": 43200
  },
  "indicator": "banner" | "tray" | "none",
  "ctl": true,
  "overrides": { "source": "testpattern", "encoder": "soft" }   // TEST ONLY — see below
}
```

notes on the fields that are easy to get wrong:

- **`now` is the only clock the streamer trusts.** section 11 says why. a bundle without it is rejected with
  exit 10: there would be nothing left to check `exp` against but the kiosk's wall clock.
- **`streamerEpoch`** anchors section 4's timestamps and is echoed to the browser in `hello-host`.
- **`sessionKey` is `K_session`,** derived by the api as section 11 specifies. the streamer needs it to derive
  each viewer's `k`; it holds no long-lived credential of any kind, which is why this arrives per session
  rather than being provisioned. it is never returned to a viewer, never persisted, and zeroized on drop.
- **`indicator`** travels here rather than being read from firestore by the agent, so the streamer and the
  tray agree without a second read path.
- **`ctl`** is the session floor described in section 5, not a grant. a viewer's own `ctl` comes from its jwt.
- **`overrides` is a test-only hook.** a streamer built **without** the `testhooks` cargo feature MUST reject
  a bundle carrying `overrides` with **exit 10**. it is never in the default feature set of a release build.

golden vectors: `bundle/bundle-valid.json`, and the rejects `bundle-overrides-no-testhooks.json` (exit 10),
`bundle-missing-anchor.json` (exit 10), `bundle-version-mismatch.json` (exit 11). every value in them is fake.

---

## 8. jwt claims

EdDSA (ed25519) only. `alg` is pinned to `EdDSA`; any other value, `none` included, is a refusal. tokens are
minted **only** by the owlette api and verified independently by the worker **and** by the streamer.

**the verification order is normative and lives in [section 11](#11-security).** it is
`kid` → signature → `iss`/`aud`/`role` → `exp` → `fp` → site/machine/sid → `jti`. an earlier draft of the task
listed signature before `kid`; that order cannot be implemented, because the key cannot be selected before
`kid` is read. do not "restore" it.

| claim | viewer | host | doorbell | |
|---|---|---|---|---|
| `iss` | ✓ | ✓ | ✓ | always `owlette-api` |
| `aud` | `swoop-host` | `swoop-signal` | `swoop-signal` | must match the verifier |
| `role` | `viewer` | `host` | `doorbell` | |
| `site` | ✓ | ✓ | ✓ | `^[A-Za-z0-9_-]{1,64}$` |
| `machine` | ✓ | ✓ | ✓ | same pattern |
| `sid` | ✓ | ✓ | — | a doorbell names no session |
| `viewer` | ✓ | — | — | per-viewer id, the `info` of the `k` derivation |
| `uid` | ✓ | — | — | the acting user, for the audit trail |
| `ctl` | ✓ | — | — | control or watch-only. the host enforces this, not the browser |
| `fp` | ✓ **mandatory** | — | — | the browser's dtls fingerprint. section 11 |
| `iat` / `exp` | ✓ | ✓ | ✓ | viewer `exp` ≤ 60 s after `iat`; host and doorbell ≤ 300 s |
| `jti` | ✓ | ✓ | ✓ | single use where the verifier has durable state |

a viewer token is presented twice: once to the worker on the websocket upgrade, and once to the streamer
inside the offer exchange, where the `fp` comparison against the actual offer happens. a lease renewal
(section 10) is a fresh viewer token presented a third time and every time after.

golden vectors: `jwt/` — valid viewer, host and doorbell tokens, a token signed with the previous `kid` during
an overlap window, and the rejects `jwt-viewer-no-fp.json` (`fp_missing`), `jwt-viewer-expired.json`
(`expired`), `jwt-viewer-wrong-machine.json` (`machine_mismatch`), `jwt-viewer-unknown-kid.json`
(`unknown_kid`). every vector is signed with the **fake** keypairs in `testdata/protocol/keys.test-only.json`,
whose private seeds are printable ascii and are published on purpose so a verifier test can actually run.

---

## 9. the host fingerprint mac

the relay is untrusted. the browser must be able to tell the host's dtls fingerprint from one a compromised
relay substituted, and it does that with a mac keyed by a secret the relay never sees.

```
MAC = HMAC-SHA256(k, "owlette-swoop/host-fp/v1" || 0x00 || sid || 0x00 || viewerId || 0x00
                     || host_fingerprint_canonical)
```

- `k` is the per-viewer key from section 11's derivation. the api returns a viewer its own `k` and never
  returns `K_session` to anyone.
- every `||` is plain concatenation of utf-8 bytes; `0x00` is one zero byte, present so
  `sid="ab", viewerId="c"` and `sid="a", viewerId="bc"` cannot collide.
- `host_fingerprint_canonical` is the host's dtls fingerprint in the **same canonical form as `fp`**:
  `<hash-func> <HEX:WITH:COLONS>`, hash token lowercase (`sha-256`), hex uppercase, colon separated, exactly
  as an sdp `a=fingerprint:` attribute value.
- the host puts the mac, base64url, in the `mac` field of its `answer`.
- the browser recomputes it and compares **in constant time** before accepting the answer. a mismatch, or an
  absent `mac`, aborts the connection — it never "proceeds and warns".

the exact hkdf salt, info and length literals for `K_session` and `k` are in section 11 and must not drift.
golden vector: `crypto/hkdf-and-host-mac.json` carries the derivation and the mac input laid out byte for
byte, with the expected outputs, so a drifted literal fails a test rather than a deployment. the same mac is
the `mac` field of `signaling/signal-answer.json`.

---

## 10. lease renewal

a live session holds a **5-minute lease** the browser renews silently, and an absolute cap of **12 hours**.
the point of the lease is that authorisation is re-checked while the session runs: a member removed from the
site, a site that turns swoop off, a capability revoked or a machine excluded all take effect within one
lease rather than at the next reconnect.

1. every `leaseSeconds` (default 300, from the bundle's `enablement`) the browser calls
   `POST …/swoop/sessions/{sid}/lease`. the api re-checks membership, site enablement and capability and, if
   all still hold, mints a **fresh viewer jwt** — same claims, new `iat`/`exp`/`jti` — and returns it with the
   new `expiresAt`.
2. the browser forwards that token to the host on `swoop-control` as `{"t":"lease","token":"…"}`.
3. the host verifies it exactly as it verified the connect token (section 11's order), with one addition: the
   token's `fp` MUST equal the fingerprint of the **already established** dtls session. it answers
   `{"t":"lease-ok","expiresAt":…}`.

carrying the renewal through the browser is deliberate: it needs no server→host push path, no new route, and
no second verification code path. a browser that cannot produce a valid renewal is, by construction, a browser
the api refused to renew.

**host behaviour on a missed renewal.** the host tracks each viewer's lease expiry against the bundle's time
anchor plus monotonic elapsed — never the wall clock. at `expiry + 30 s` grace it:

- drops that viewer, closes its peer connection and emits
  `viewer_left` with `reason: "lease_expired"`;
- reports the drop to `POST /api/agent/swoop/events` so the audit trail records why the session ended;
- keeps serving every other viewer — one expired lease never ends anyone else's session.

when the last viewer is gone the streamer lingers about 60 s and exits 0 with `reason: "idle"`.

**the 12-hour cap** (`sessionCapSeconds`, default 43200) runs from `ready`. at the cap the streamer ends the
session for everyone and exits 0 with `reason: "session_cap"`, regardless of how healthy the leases are. it is
a hard stop, not a renewal ceiling.

the kill switch is faster and independent of all of this: the worker broadcasts `kill`, the streamer exits,
and that path completes in ≤ 2 s. the polled command is only the last resort for a machine with no socket.

---

## 11. security

> the block below is pasted verbatim from the threat model memo. the exact strings are load-bearing: a drifted
> salt or info string is a silent interop failure between the api, the streamer and the browser. detail may be
> added around it; the normative sentences and the literals do not get reworded.

---

### Security

This section is normative. Every MUST here has a golden vector in `testdata/protocol/`.

#### Token verification order

A verifier (Worker or streamer) processes a swoop JWT in exactly this order and stops at the first
failure:

1. **`kid`** — read the header's `kid` and select the public key. Unknown `kid` → refuse, log the
   `kid` value only (never the token), and let the service re-fetch the bundle. Never fall back to
   "try every key".
2. **Signature** — EdDSA (Ed25519) over the selected key. `alg` is pinned to `EdDSA`; any other value,
   including `none`, is a refusal.
3. **`iss` / `aud` / `role`** — `iss = owlette-api`; `aud ∈ {swoop-signal, swoop-host}` and MUST match
   the verifier; `role ∈ {viewer, host, doorbell}` and MUST be permitted for the message being sent.
4. **`exp`** — see *Expiry*. Refuse on absence.
5. **`fp`** — see *Fingerprint binding*. Refuse on absence.
6. **Site / machine / sid** — `site` and `machine` MUST equal this streamer's own; `sid` MUST equal the
   live session. A token for another machine is refused even if the room or URL says otherwise.
7. **`jti`** — single use. See *Weight*.

*(Note for implementers: `kid` necessarily precedes signature verification, because the key cannot be
selected otherwise. Task 0.5's brief listed signature first; the order above is the one to implement.)*

#### Fingerprint binding — `fp` is mandatory

- The viewer JWT MUST carry `fp`, the browser's own DTLS certificate fingerprint, in the canonical form
  `<hash-func> <HEX:WITH:COLONS>` — hash function token lowercase (`sha-256`), hex uppercase, colon
  separated, exactly as an SDP `a=fingerprint:` attribute value.
- A token **without** `fp` MUST be rejected. It MUST NOT degrade to "no binding required": a 60-second
  bearer token with no binding defeats the entire confused-deputy defence and fails invisibly.
  Negative golden vector: `viewer-jwt-no-fp` → `reject`, reason `fp_missing`.
- The streamer MUST compare `fp` against the `a=fingerprint:` line of the offer it received, after
  canonicalising both, in constant time. A mismatch MUST be rejected and reported to
  `POST /api/agent/swoop/events` as a denial. Negative golden vector: `viewer-jwt-fp-mismatch` →
  `reject`, reason `fp_mismatch`.
- The API MUST refuse to **mint** a viewer token without `fp`. The browser obtains it from
  `RTCCertificate.getFingerprints()` or, where that is unavailable, by parsing `a=fingerprint:` out of
  its own `createOffer()` SDP before posting.

#### Expiry — `exp` against the bundle's time anchor, never the kiosk clock

- The bundle carries an authoritative `now`, taken from the API's own clock at bundle-mint time.
- The streamer MUST verify `exp` against **that anchor plus monotonic elapsed time since the bundle was
  read** (`Instant::now()` deltas). It MUST NOT call `SystemTime::now()` for this purpose.
- Rationale, and it is not theoretical: these are signage and kiosk boxes whose clocks drift. The
  agent already drops wrong wall-clock timestamps for this reason
  (`agent/src/watchdog_state.py:96`) and prefers the monotonic clock throughout
  `agent/src/connection_manager.py`. A streamer checking a 60-second `exp` against a drifted wall clock
  either refuses every session or acquires a generous leeway in a hotfix — and that leeway *is* the
  replay window.
- `exp` MUST be ≤ 60 s after issue. A token whose `exp` precedes the anchor is refused; the same token
  is accepted against a later anchor. Golden vector: `viewer-jwt-expired-vs-anchor` → `reject`,
  reason `expired`.

#### Key rotation — `kid` with a two-key overlap

- Every token header carries `kid`. Every bundle carries **both** the current and the previous
  `SWOOP_JWT_PUBLIC_KEY` with their `kid`s; the Worker holds the same two.
- During an overlap window both keys verify. Outside it, only the current one is shipped.
- **Unknown `kid` → refuse the token, log the `kid`, and let the service re-fetch the bundle.** Never
  accept an unverified token, and never try keys until one works.
- The rotation runbook (order of operations across API, Worker and fleet) lives in
  `infra/swoop-signal/README.md`.

#### Weight of the defences

**The security of a session rests on `fp` + `exp`, not on `jti`.** A stolen viewer token is useless to
anyone who does not also hold the victim browser's DTLS private key, and it is useless after 60 seconds
against the bundle's anchor. `jti` single-use is **belt-and-braces**: it is enforced where the verifier
has durable state (the Durable Object), and the streamer — which has no store across spawns — enforces
it only for the lifetime of the current process. A `jti` check that cannot be made durable is therefore
not a reason to relax `fp` or `exp`, and the absence of a `jti` record after a streamer restart is not
a vulnerability.

#### Key derivation — derived, never stored

```
K_session = HKDF-SHA256(
              IKM  = SWOOP_SESSION_MASTER_KEY,
              salt = "owlette-swoop/session/v1",
              info = sid,
              L    = 32 )

k         = HKDF-SHA256(
              IKM  = K_session,
              salt = "owlette-swoop/viewer/v1",
              info = viewerId,
              L    = 32 )
```

- `sid` identifies **one streamer lifetime on one machine**. Later viewers attach to the live `sid`
  and are separated by `viewerId`, never by a new `sid`.
- Both values are derived on demand and **never persisted** — not in `swoop_sessions/{sid}`, not in a
  command document, not in a log, not on disk. `swoop_sessions` holds no key material, tokens or TURN
  credentials.
- The API returns a viewer's own `k` to that viewer and **never** returns `K_session` to anyone.
  HKDF is one-way, so a viewer holding `k` can recover neither `K_session` nor another viewer's `k`,
  and the relay sees neither.
- The host proves its identity with
  `MAC = HMAC-SHA256(k, "owlette-swoop/host-fp/v1" || 0x00 || sid || 0x00 || viewerId || 0x00 ||
  host_fingerprint_canonical)`, where `host_fingerprint_canonical` is the host's DTLS fingerprint in
  the same canonical form as `fp`. The browser recomputes and compares in constant time before
  accepting the answer, so a relay that substitutes its own fingerprint is detected.
- In Rust, every secret from the bundle is wrapped in `zeroize` and wiped on drop. The bundle is never
  logged, never written to disk, never echoed in an error message — not at debug, not partially.
  Error types carry no bundle field in their `Display` or `Debug` output.

#### The sid-only contract

**The doorbell ring and the Firestore fallback command are notifications. They are never carriers.**

- `POST /v1/ring` and `POST /v1/kill` take a `sid` and nothing else, authenticated with
  `SWOOP_SIGNAL_RING_SECRET` compared in constant time. A ring carrying any extra field is refused.
- The Firestore command document at `sites/{s}/machines/{m}/commands/pending` holds **only** `{type}`,
  plus `sid` where the type carries one, plus the canonical envelope (`siteId`, `machineId`,
  `timestamp`, `status`, `queuedBy`) and the writer's lifecycle fields. Per type: `sid` is **mandatory**
  for `swoop_session_requested`, **optional** for `swoop_kill` (absent means "kill whatever is
  running"), and **never present** for `swoop_refresh` (an enablement toggle names no session).
- No bundle, no JWT, no key, no TURN credential, no viewer id, no uid. The reason is not stylistic:
  **every active site member can read that collection** — `firestore.rules:303-306` admits
  `canAccessSite(siteId)`, and `canAccessSite` is any active member (`firestore.rules:162-165`).
- The bundle is fetched by the agent alone, from `POST /api/agent/swoop/bundle`, over its own
  authenticated channel, and reaches the streamer as **one line on an inherited anonymous stdin pipe**.
  There is **no file fallback** — not under `{app}`, not under `tmp/`, not anywhere — and the bundle is
  never passed on a command line.
- The three swoop command types are absent from `ALLOWED_COMMAND_TYPES` and are written by one
  dedicated action module, so the generic commands route cannot reach them.

---

### golden vector names

the block above names two vectors by their design-memo names. in `index.json` they are
`jwt/jwt-viewer-no-fp.json` (`fp_missing`) and `jwt/jwt-viewer-expired.json` (`expired`). the `fp_mismatch`
case is not a static vector — it is a comparison against a live offer's `a=fingerprint:` line, so it is
covered by the streamer's own unit test rather than by a file here.

---

## the golden vectors

`testdata/protocol/index.json` is the manifest. its shape is contract, because the web protocol library and
the rust protocol core both iterate it:

```jsonc
{
  "version": 1,
  "protocolVersion": 1,
  "keys": "keys.test-only.json",
  "timeAnchor": 1789344000,
  "streamerEpoch": 1789344000000000,
  "vectors": [
    {
      "file": "jwt/jwt-viewer-no-fp.json",   // path relative to index.json
      "kind": "jwt",                          // which contract this exercises
      "format": "json" | "ndjson" | "binary",
      "expect": "accept" | "reject",
      "reason": "fp_missing",                 // "ok" when expect is accept
      "description": "…",
      // optional, per kind: "expected", "state", "exitCode"
    }
  ]
}
```

every entry has `file`, `kind`, `format`, `expect` and `reason`. an implementation iterating the manifest MUST
fail on an unknown `kind` rather than skipping it — a vector nobody runs is worse than no vector.

**all key material here is fake.** `keys.test-only.json` holds two ed25519 keypairs whose private seeds are
the printable ascii strings `swoop-golden-vector-test-key-001` and `-002`. they are published deliberately so
that signature verification can actually be exercised; they sign nothing real, they are not
`SWOOP_JWT_PRIVATE_KEY`, and an environment that accepts them is misconfigured. the turn credentials, host
token and session key in the bundle vectors are literal placeholder strings.
