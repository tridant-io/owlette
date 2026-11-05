# swoop on a phone

owner asks, 2026-10-26: one icon for the session bar on a phone, pinch to zoom, a
cursor preview so you know where a tap lands, and anything else that helps.
owner rulings the same day: **one menu button** in a one-row bar (not a floating
button); **direct touch with a magnifier** (not a trackpad); extras **phone
keyboard, key row, haptic ticks**.

web only: no agent change, no protocol change. the host already takes `m`, `b`,
`w` and `k`; everything here is how a phone produces them.

## found while reading

- a tap clicks wherever the pointer was last. `input.ts` sends `b` on
  pointerdown with no `m` first, and a finger has no hover to move it there.
  a pen without hover has the same bug.
- no way to type: the stage is a div, so a phone never opens its keyboard.
- no pointer drawn on a phone: outside the app the machine's shape is a css
  cursor, which a touch screen never shows.
- the fullscreen button fails on an iphone (no element fullscreen there), and
  the bar-position menu does nothing below `md`, where the bar is always on top.
- the host's feedback viewport is stats only (governor reads it in tests only),
  so a zoomed picture's bigger box changes nothing on the host.
- the host turns a pixel wheel into notches at 100 px each (`PIXELS_PER_NOTCH`).

## the gestures (touch only; mouse and pen unchanged)

| gesture | does |
|---|---|
| tap | move there, click |
| second tap within 350 ms and 24 px | clicks at the first tap's point, so the host counts a double-click |
| press 400 ms, slide, lift | magnifier with the pointer; the pointer follows; lift clicks there, lift off the picture cancels |
| drag (past 10 px before 400 ms) | left button down at the start, follows, up on lift |
| two-finger tap | right-click at the first finger |
| two-finger drag | scroll; content follows the fingers (wire px = finger css px / picture scale) |
| pinch | local zoom 1–5×, anchored under the fingers; the fingers' travel pans |

a two-finger gesture is a pinch when the spread changes more than the centroid
moves over its first 10 px, a scroll otherwise, and stays that for its life.
extra fingers during a drag or aim are ignored. pointercancel releases. a
gesture that starts on the letterbox bars sends nothing, as a mouse there
doesn't (spec review: on an upright phone the bars are ~70% of the stage).

## pieces

1. `lib/swoop/input.ts`: touch pointer events are not its own (it skips
   `pointerType === 'touch'`); pointerdown sends the move before the press; new
   capture methods the touch layer drives: `pointAt(clientX, clientY)`,
   `press(button)`, `release(button)`, `scroll(dx, dy)`, `typeKey(code, shift)`
   (through the held set, so an armed modifier applies and lets go). keys from
   the phone keyboard's textarea are not the stage's.
2. `lib/swoop/zoom.ts`: scale + pan with clamps, anchor math, a store.
   applied as a transform on the `<video>`; `contentRect()` reads the video's
   transformed box, so input normalisation follows on its own.
   `useSwoopPictureBox` re-measures on zoom change.
3. `lib/swoop/touch.ts`: the gesture machine above, fake-clock testable,
   driving the capture and the zoom; aim state as a store; `navigator.vibrate`
   ticks on aim and right-click. attached as a `touch` feature in `features.ts`
   (control sessions only; a watcher still pinches).
4. ui: `SwoopMagnifier` (canvas loupe above the finger, the machine's pointer
   at its centre), `SwoopZoomPill` ("fit", while zoomed), the stage gets
   `select-none` + no ios callout + a `gesturestart` guard; `SwoopCursor` draws
   its overlay on a coarse pointer.
5. bar: below `md`, or on any touch screen, the right-hand controls move into
   one popover behind an ellipsis button, each with its label under it
   (tooltips don't exist on touch); notices are icons there and the row never
   wraps. fullscreen and mouse capture only where `requestFullscreen` exists;
   bar position only from `md` up.
6. phone keyboard: a keyboard control focuses a hidden textarea in the stage;
   `input` events are diffed against its last value into backspaces and typed
   keys through a us-layout table (smart quotes and dashes folded to ascii).
   what the table lacks is dropped and said once. key row above the keyboard,
   on the visual viewport's bottom edge: esc, tab, ctrl, alt, win/cmd (sticky,
   lit while armed, combinable; a second tap or hiding the keyboard lets go),
   arrows, hide. `holdNextKey` holds a set, so ctrl+alt works.
7. e2e: the fake host records `swoop-input`; a phone-sized spec proves the
   one-button bar, tap → `m` at the tap then `b` down/up, pinch → zoom and fit,
   two-finger tap → right-click, typing → the right codes. unit tests for
   input, zoom, touch and the text table. docs page and changelog.

## limits, said plainly in the docs

- typing goes as a us keyboard's keys: no accents, no emoji, until an agent
  release adds a text path to the protocol (the wave 6 seam in `input.ts`).
- vibration is android only; iphones don't allow it from a page.
- real-device proof (ios safari, android chrome) is the owner's: the rig is
  chromium touch emulation.
