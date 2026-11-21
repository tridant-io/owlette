# Tutorial web-capture harness

Drives the dashboard at 1080p against the seeded demo fleet and records one **`.mp4`**
per scene — the web-footage half of the tutorial pipeline (the other halves are the
ElevenLabs voiceover and the native/desktop capture; see `dev/video-tutorials/`).

Playwright drives; an **external ffmpeg subprocess captures the desktop region** the
browser content occupies. Playwright's own `recordVideo` is switched off
(`playwright.videos.config.ts` sets `video: 'off'`) — 25fps VP8 with opportunistic frame
grabs is fine for debugging and wrong for tutorial video.

This is a **sibling of the screenshots harness** (`../screenshots/`). It reuses the same
emulator boot, `global-setup` (role fixtures), `webServer`, and — crucially — the same
deterministic demo data (`../screenshots/fixtures.ts`: a 10-machine AV/signage fleet,
hoot chats, roost rollouts, schedule presets, talons).

Sixteen scenes ship today — `01`–`08` and `10`–`17`. Episode `09` is the owlette app on
the machine and belongs to the desktop harness, not this one; the map at the bottom names
which fixture scenario each scene runs on.

## Run

```bash
cd web
npm run videos                       # every scene
# ONE scene: npm's `--` lands the flag on `firebase emulators:exec`, which dies
# AFTER the ~10-min build — grep must live inside the quoted playwright command,
# space-free (firebase runs the inner string through cmd.exe):
#   firebase emulators:exec --only auth,firestore,storage --project demo-playwright-e2e "cd web && npx playwright test --config=playwright.videos.config.ts --grep on.a.schedule"
npm run videos:debug                 # headed + inspector, to tune selectors/pacing
```

Grep by a **slug word**, not by episode number: every scene title carries its file's
number (`04-dashboard-tour.video.ts` is `episode 4 — …`), but `--grep "episode 1"` also
selects `episode 10`–`17` and the `b02` scene. (If you renumber an episode, the title is
part of the rename — one more step than `series-outline.md`'s migration-mechanics list
currently names.)

Never runs in CI — it needs a real desktop. Output: `dev/video-tutorials/footage/web/<scene>.mp4`.
A capture in flight writes `<scene>.mp4.tmp.mp4` and is renamed only after ffmpeg exits
cleanly, so a half-written file never poses as a valid clip.

Capture path: ffmpeg records via ddagrab + h264_nvenc and falls back to gdigrab +
libx264 on a machine without DXGI/NVENC; the chosen path is logged as
`[ffmpeg] capture path: …`. Pin it with `OWLETTE_VIDEO_CAPTURE_PATH=primary`
(fail rather than shoot degraded footage) or `=fallback` (exercise the GDI path
on an NVENC box). Verify the hardware first with `node scripts/probe-capture.mjs`.

## Prereqs

Everything the E2E suite needs (JDK 21, `firebase-tools@15`, chromium installed), **plus
the ones the ffmpeg path added**:

- **`ffmpeg` and `ffprobe` on PATH.** For the primary path the build needs the `ddagrab`
  filter and the `h264_nvenc` encoder, on a machine with DXGI desktop duplication and an
  NVENC-capable NVIDIA GPU. Without them the run degrades to gdigrab + libx264
  automatically — slower, CPU-heavy, format-identical.
- **An interactive, unlocked desktop session.** Capture is a desktop region, not an
  in-browser recording, and the config runs `headless: false`. A headless box, a locked
  workstation or an RDP session that has been disconnected produces no usable video
  (DXGI desktop duplication is one of the first things to fail there).
- **A primary display of exactly 1920×1080 at 100% Windows scaling.** `recordScene`
  puts the window into **true fullscreen** (CDP `Browser.setWindowBounds` →
  `windowState: 'fullscreen'`), so the renderer fills the display exactly and the
  capture region is simply `(0,0) 1920×1080` — no window-chrome arithmetic at all.
  (Two earlier positioning schemes derived the chrome from `outer − inner` window
  metrics; both were measurably wrong — an 8px desktop L-shape in one batch, a 6px
  titlebar sliver in the next. Visible chrome is not knowable from JS, so it was
  removed instead.) The geometry is verified after the transition (`screenX/Y === 0`,
  `outer === inner === 1920×1080`, fail-loud) and again on pixels after every take
  (`assertEdgesClean`). `openForCapture` additionally asserts the viewport and
  `devicePixelRatio === 1`, so a scaled display is caught immediately rather than
  shipped blurry.
- Multi-monitor: gdigrab offsets are virtual-desktop coordinates while ddagrab's are
  relative to `output_idx=0`, so the two agree only while the primary monitor sits at
  virtual (0,0).

## How a scene works

```ts
test('episode N — title', async ({ browser }) => {
  const ctx = await seedScreenshotFixtures('dashboard-mixed-states'); // pick a scenario
  try {
    await getAdminDb().collection('users').doc(TEST_USERS.admin.uid)
      .set({ lastSiteId: ctx.siteId }, { merge: true });          // auto-select the site
    await recordScene(browser, 'NN-slug', { baseURL: E2E_BASE_URL,
      storageState: roleState('admin').storageState }, async (page) => {
        await openForCapture(page, '/dashboard');                 // goto + settle
        await narrate(page, 'b01 ...', 6);                        // dwell ~6s for the beat
        await clickWithCursor(page, page.getByTestId('view-toggle-list'));
        await narrate(page, 'b02 ...', 8);
      });
  } finally {
    await ctx.cleanup();
  }
});
```

- File names end in `.video.ts` (the config's `testMatch`), numbered to match the script
  in `dev/video-tutorials/scripts/`.
- Each scene records its OWN context (`recordScene`) so the `.mp4` is named after the
  episode, not Playwright's auto hash. A throwing scene still stops the recorder in
  `finally` — no orphaned ffmpeg.
- `narrate(page, beat, seconds)` is a dwell sized to that beat's **rendered** voiceover,
  never a guess — from the repo root:
  `ffprobe -v error -show_entries format=duration -of csv=p=0 dev/video-tutorials/voiceover/out/NN-slug/epNN-bNN.mp3`,
  rounded up ~0.5s. Re-voice a beat and its `narrate()` budget moves with it.
- **Beat timing is enforced, not trusted.** `narrate` reads each beat's real MP3
  duration from `dev/video-tutorials/assembly/manifests/` and, when a beat *closes*
  (the next beat's first `narrate`, or end of scene), holds the picture until the beat
  has earned `mp3 + 0.75s` of screen time. The hold lands on the beat's resting frame —
  never mid-beat, where it would freeze the motion the narration describes. Scripted
  dwells are pacing minimums; the enforcement is the sync guarantee.
- **Every take writes a `<scene>.beats.json` sidecar** (beat id, measured start, MP3
  length, measured video length) next to the `.mp4`. The Resolve builder
  (`assembly/resolve/build_episode.py`) cuts V1 from these sidecars — each beat's
  picture is trimmed to its narration length and placed at the narration's own
  timecode. No sidecar → the builder falls back to butt-jointing and warns loudly.
  The first beat's segment starts when `openForCapture`'s first page is *ready*, so an
  episode never opens on the pre-roll/navigation loading flash.
- **Every take is pixel-audited before it may pass** (`assertEdgesClean`): outer
  left/bottom strips vs inner reference strips at three timestamps (chrome/desktop
  contamination fails the take), plus a center-brightness check so an all-black
  capture can never pass vacuously. `dev/video-tutorials/assembly/vet-recordings.py`
  runs the same audit — plus sidecar coverage and per-episode gap listing — across all
  footage at once.
- `installFakeCursor` (called by `recordScene`) draws a visible pointer + click ripple;
  the real OS cursor is excluded from capture (`draw_mouse=0`) so exactly one pointer is
  ever in frame.
- Other helpers in `video-helpers.ts`: `moveCursorTo`, `clickWithCursor`, `typewrite`,
  `highlight`, `slowScrollToBottom`, `centerInView`.
- `assertCaptureValid(outPath, expectedSeconds)` in `ffmpeg-recorder.ts` ffprobes a
  finished clip (1920×1080 / h264 / yuv420p / duration). It is available but **not** wired
  into `recordScene` — call it from a scene if you want that gate.

## Why an external ffmpeg

`recordVideo` gives ~25fps VP8 with opportunistic frame grabs and a downscaled default —
acceptable for a debugging artifact, not for footage that will sit in a timeline next to
narration. The ffmpeg path records 60fps constant-GOP H.264 with bt709 metadata and
`+faststart`, which an NLE can scrub frame-accurately. The cost is the desktop
prerequisites above, which is why they are prerequisites and not suggestions.

## Determinism

Inherited from the screenshots harness: fixed clock (`FIXED_NOW_MS`), disabled CSS
animations, seeded PRNG sparklines, fixed machine ids. See `../screenshots/README.md`.

One video-specific rule: the clock is frozen with a `Date`-only `addInitScript`, **not**
`page.clock.*` — the clock API routes `requestAnimationFrame` through its controller and
freezes in-page scroll animation. `openForCapture` rAF-smokes three frames so that
regression fails at the top of a scene instead of 60s in.

## Scenario → episode map

Scenarios come from `../screenshots/fixtures.ts`; each script declares the one it uses in
its front matter (`dev/video-tutorials/scripts/NN-slug.md`).

| Scenario (fixtures.ts) | Episodes | Scene file(s) |
|---|---|---|
| `dashboard-mixed-states` | 1 (b-roll, and beat b02), 4 (dashboard), 7 (health), 8 (remote actions), 17 (fleet maintenance) | `01-what-is-owlette`, `01-what-is-owlette-b02`, `04-dashboard-tour`, `07-reading-machine-health`, `08-remote-actions`, `17-fleet-maintenance` |
| `pairing-first-machine` | 3 (web beats) | `03-install-and-pair` |
| `control-process-restarting` | 5 (keep alive), 16 (logs) | `05-keep-a-process-alive`, `16-logs-and-troubleshooting` |
| `automate-schedule-editor` | 6 (schedule), 14 (team & alerts) | `06-run-on-a-schedule`, `14-team-and-alerts` |
| `deploy-roost-rolling` | 10 (deploy), 11 (roost) | `10-deploy-software`, `11-distribute-with-roost` |
| `diagnose-cortex-chat` | 12 (hoot) | `12-cortex` |
| `automate-talons-list` | 13 (talons) | `13-talons` |
| `display-layout-editor` | 15 (display layouts) | `15-display-layouts` |
| — (no scenario; drives real signup/2FA) | 2 (day zero) | `02-day-zero` |
| `display-storyboard-frame-1/-2/-3` | — | marketing landing frames only (`../screenshots/display-storyboard.spec.ts`) |
| `monitor-single-machine` | — | screenshots only (`../screenshots/monitor.spec.ts`, `machine-detail.spec.ts`); episode 7's scene deliberately uses `dashboard-mixed-states` instead |

Episode 12 keeps the `cortex` spelling in its filename and in the
`diagnose-cortex-chat` scenario key on purpose — the product renamed to **hoot** in the
UI while wire- and storage-level names stayed put. The scene's copy and routes are
already hoot.

Episode 3's front matter declares `dashboard-mixed-states`, but its web scene uses
`pairing-first-machine` on purpose: b08 films a machine card *arriving*, which only reads
on a site that had none, and the episode's whole subject is the first machine. The script
front matter is the plan; the scene header records the departure.

Still to write: nothing — every episode with web beats now has a scene. Not this harness
at all: **3**'s installer wizard
(`dev/video-tutorials/capture-native/`) and **9** (the owlette app on the machine), which
is the desktop app over WebView2 CDP — `../desktop-screenshots/` is the harness to extend.

## Per-episode workflow

Script → voiceover → capture → assemble is documented once, in
[`dev/video-tutorials/README.md`](../../../dev/video-tutorials/README.md). This file only
covers the capture step for web episodes.
