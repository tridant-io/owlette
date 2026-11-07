# swoop text clarity (4.1.28) — Context
**Last updated**: 2026-11-04 (revised after two plan reviews)

Release 4.1.28, "swoop text clarity". Cut from dev after `release/4.1.27` merges. Anchors in tasks.md are `release/4.1.27` @ f5a97522. Research: the session scratchpad's `research/swoop-clarity.md` and `research/owner-decisions.md`.

## Key Files

### Create
- `agent/swoop/src/encode/gate.rs` — the encode-time gate both hardware encoders share (1.2)
- `agent/swoop/spikes/smooth-probe/` — `.gitignore`, `server.mjs`, `drive.mjs`, `public/index.html`, `public/probe.js`, `public/clock.html`: the probe that measures the shipped renderer in any browser (2.5; run by 3.4, 4.1, 5.2)
- `web/lib/swoop/view.ts` — `layoutPicture`: fit, snap, sharp, whole device pixels (1.4)
- `web/lib/swoop/viewStore.ts` — size and smooth scaling per browser, and smooth scaling's engine default (1.5)
- `web/lib/swoop/video/smooth.ts` — the WebGL2 area-average renderer and `smoothAvailable()` (1.6)
- `web/hooks/useSwoopView.ts` — writes the layout onto the video, re-runs it on every change; exports `smoothCanDraw`/`smoothActive` (2.3, 3.1)
- `web/e2e/specs/swoop/clarity.spec.ts` — snap, sharp, smooth scaling, stats rows, input, the watchdog under the canvas (5.1)
- tests: `web/__tests__/lib/swoop/view.test.ts`, `viewStore.test.ts`, `smooth.test.ts`, `web/__tests__/hooks/useSwoopView.test.tsx`
- only if argued in review: `docs/adr/0016-swoop-draws-minified-frames-on-a-canvas.md` (6.1)

### Modify — streamer (`agent/swoop`)
- `src/session/quality.rs`, `src/transport/governor.rs`, `PROTOCOL.md` (prose only) — the ladder (1.1)
- `src/encode/mod.rs` — declares `gate`; `Encoder::share_encode_time`, defaulted (1.2)
- `src/gpu/scale.rs` — the usage per caller, the CPU area average (1.3); the measured choice (4.1)
- `src/encode/nvenc/mod.rs` — text preset, gate, fallback (2.1); the timing table (4.1)
- `src/encode/mf/hw.rs` — quality vs speed, gate, fallback (2.2); its numbers (4.1)
- `src/session/mod.rs` — each encoder's share of the pass (2.4); refinement once motion stops (3.3)
- `src/gpu/vt_transfer.rs` — a measurement test only (3.4)

### Modify — web
- `web/components/swoop/SwoopStatsOverlay.tsx` — shown at (1.7); scaling and the estimate row (3.1)
- `web/e2e/helpers/swoopHost.ts` — a chosen size, the detail band (1.8)
- `web/components/swoop/SwoopStage.tsx` — the stage's test id, the area, the positioned video (2.3); the canvas (3.1)
- `web/hooks/useSwoopSession.ts` — contentRect (2.3); canvasRef, onPresent (3.1)
- `web/hooks/useSwoopPictureBox.ts`, `web/lib/swoop/touch.ts`, `web/lib/swoop/zoom.ts`, `web/components/swoop/SwoopMagnifier.tsx`; doc-only `web/lib/swoop/features.ts`, `web/components/swoop/SwoopPhoneKeyboard.tsx` (2.3)
- `web/e2e/specs/swoop/session.spec.ts` — stage lookups (2.3), the menu's name (3.2); `web/e2e/specs/swoop/viewer-app.spec.ts` (2.3); `web/e2e/specs/swoop/bar-position.spec.ts` (3.2)
- `web/components/swoop/SwoopQualityMenu.tsx` (3.2)
- `web/lib/swoop/video/receiver.ts`, `web/lib/swoop/video/presenter.ts`, `web/app/swoop/[siteId]/[machineId]/page.tsx` (3.1)
- `web/lib/swoop/video/smooth.ts`, module doc only (2.5, 3.4, 4.1); `web/lib/swoop/viewStore.ts` (4.1, only if a canvas gate fails)
- `web/playwright.config.ts`, `web/e2e/COVERAGE.md` (5.1)
- tests: `touch.test.ts`, `zoom.test.ts`, `receiver.test.ts`, `presenter.test.ts` under `web/__tests__/lib/swoop/`; `SwoopStage.test.tsx`, `SwoopStatsOverlay.test.tsx`, `SwoopQualityMenu.test.tsx` under `web/__tests__/components/`; `web/__tests__/hooks/useSwoopSession.test.tsx`; `swoop-viewer-ended.test.tsx` and `swoop-viewer-refused.test.tsx` under `web/__tests__/app/` (both render the real stage in jsdom) (2.3, 3.1)

### Modify — docs and release
- `web/content/docs/dashboard/swoop.mdx`, `GLOSSARY.md` (Quality ladder), `README.md`, `docs/changelog.md`, `web/content/docs/changelog.mdx`, `dev/active/swoop/plan.md` (a line under D17) (6.1)
- the version surfaces `scripts/sync-versions.js` writes, `desktop/package-lock.json`, the four `Cargo.lock` files, both changelog headings, `web/public/docs-screens/*` (7.1)

### Not touched
`firestore.rules`, `owlette_installer.iss`, `agent/swoop/src/signal/messages.rs` (no wire change), `agent/swoop/Cargo.toml` (only 7.1's version), `.github/workflows/*`, the Python agent, the desktop app and owlette swoop's Rust, `web/lib/swoop/input.ts`.

## Decisions

Full reasons in plan.md.

1. **C1** The `<video>` element's box is the picture's box, written from `layoutPicture`; contentRect is its rect; touch, input, overlays and the magnifier read the element. `fitBox` goes. The stage gets `data-testid="swoop-stage"`.
2. **C2** Plan D17 reversed on the web for minification only: a WebGL2 canvas mirrors the video and draws presented frames from the one rVFC chain. Nothing presents from rAF. No ADR unless task 3.1's reviewers argue it is hard to reverse.
3. **C3** Snap to 1:1 for r in [1, 1.1] and 1:2 for r in [0.5, 0.55]; never up (that would crop).
4. **C4** Sharp = the largest whole fraction 1:n that fits; n ≥ 3 only through the canvas.
5. **C5** The canvas draws only what the video cannot draw exactly: below 0.98 and not 1:1 or 1:2 on whole pixels, plus 1:3 and below. Area average, up to 8 texels per axis, encoded colour space.
6. **C6** Smooth scaling is on by default only in Chromium desktop engines (client hints: a `Chromium` brand, not mobile), off in WebKit, Firefox and phones until measured; a viewer's choice wins; it is the off switch (not "kill switch"); no query parameter, no fleet flag.
7. **C7** The magnifier keeps its 2D draw from the video (rAF-paced, above the pointer overlay), with high-quality smoothing; its geometry follows the shared box.
8. **C8** The ladder is frame rate only; the menu's explicit resolutions stay.
9. **C9** NVENC: P4 up to 2560x1440 pixels, P3 above; the gate counts steady frames only (previous submit within two frame intervals), warms up 30, decides early after 20 when the median is past min(1.5x budget, a frame interval), else at 120; IRAPs excluded; each gated encoder judges 12 ms divided by the pass's tiers; over budget, reopen at P1 (an IDR first) and stay there for the streamer's life (per codec).
10. **C10** mf-hw: quality vs speed 50 under the same gate; the vendor default logged first.
11. **C11** Refinement: NVENC only, only if 2.1's still-frame premise holds; motion = three fresh frames inside 100 ms; a repeat only after max(50 ms, two rung intervals) with no fresh frame; repeats every rung interval until 500 ms after the last fresh frame, then the 2 Hz floor.
12. **C12** D3D11: OPTIMAL_QUALITY for the BGRA downscale only, if within 1.0 ms of OPTIMAL_SPEED at 4K→1080p in 4.1; the NV12 convert stays SPEED; the CPU path averages; the Mac is measured, not changed.
13. **C13** Size and smooth scaling are local: per browser, never reset per session, never sent.
14. **C14** The agent measures before the release (4.1 alone on TEC-A4D, 3.4 on TEC-MBA, 5.2 on the kiosk VM); the owner measures after the merge to dev (owlette swoop loads the deployed viewer).
15. **C15** The canvas's cost: `capture → display` stays the video's figure; the overlay's canvas row is an estimate; the gates are a draw p95 ≤ 4 ms for a 4K source in Edge and an added median latency ≤ one refresh, measured by the probe's two barcodes and the owner's photos. Failing either, smooth scaling ships off by default.
16. **C16** The probe serves the shipped `smooth.ts` through Node's `stripTypeScriptTypes`, so `smooth.ts` imports nothing and uses erasable TypeScript only.

Mixed fleet: no wire change, so every pairing of a 4.1.27 or 4.1.28 viewer and streamer works; `Encoder::share_encode_time` and the gate are internal to the streamer; nothing changes what a machine does while it updates, so ADR 0006 needs no installer half.

## Seams and facts a task needs

- **The single rVFC chain** is `SwoopReceiver.armFrameCallback`/`onPresented` (receiver.ts ~269-363). `onFrame` fires only on a join with a `swoop-meta` record, which can land after the frame, so a draw hangs off the new `onPresent`, never `onFrame`. Browsers without rVFC play without the chain (receiver.ts:192-194), which is why `smoothAvailable()` asks for it.
- **Who writes the video's style**: `useSwoopView` writes left/top/width/height; touch.ts writes `transform` and `transform-origin`. Nobody else.
- **The stage and the area**: the stage is SwoopStage's `stageRef` div (`data-testid="swoop-stage"` from 2.3), the element input capture, fullscreen and the letterbox colour bind to; SwoopStage shows the fullscreen hint only when the stage itself is fullscreen (SwoopStage.tsx:190). The area is the video's parent (`data-testid="swoop-area"`); touch.ts reaches it as `video.parentElement`, so the session object gains no field.
- **jsdom**: two page tests (`web/__tests__/app/swoop-viewer-ended.test.tsx`, `swoop-viewer-refused.test.tsx`) render the real SwoopStage; jsdom has no ResizeObserver or matchMedia and `jest.setup.js` adds neither; touch.ts:406 and useSwoopPictureBox.ts:85 guard ResizeObserver with `typeof … === 'function'`.
- **Stats** reach the overlay through `useSwoopSession`'s 1 s sampler (`presenter.stats()`); the overlay must never arm its own rVFC chain.
- **The freeze watchdog** judges the video's shown frames (`totalVideoFrames − droppedVideoFrames`) and the video's box (useSwoopSession.ts ~1124-1135, `web/lib/swoop/video/stall.ts`), and declares a freeze after 3 s; a cover that stops the video counting would trip it.
- **The fake swoop host** (`web/e2e/helpers/swoopHost.ts`) is a real WebRTC peer in its own page sending a canvas track; it records every `swoop-input` message in `host.inputs` and paints `HOST_COLOUR`.
- **The e2e build** sets `NEXT_PUBLIC_USE_FIREBASE_EMULATOR=true` (playwright.config.ts ~155); `smoothCanDraw()` accepts SwiftShader only there.
- **No self-view.** The streamer ends a session whose viewer reaches it at one of its own addresses (`same_machine`, agent/swoop/src/signal/client.rs:575, PROTOCOL.md:114), and the dashboard greys swoop out for the machine you are on (web/lib/swoop/thisMachine.ts, MachineContextMenu.tsx "you're on this machine").
- **Opening owlette swoop from the dashboard**: a machine card's ⋮ button ("machine options for <name>", MachineContextMenu.tsx ~302-314) → beside **swoop**, a small screen icon "open in the owlette swoop desktop app" (~501). owlette swoop alone opens the origin it was last given (desktop/viewer/src/launch.rs:1-5), which may not be dev.
- **The quality menu's trigger** is found by name in session.spec.ts (365, 375, 511, 526), bar-position.spec.ts (169, 187) and SwoopQualityMenu.test.tsx; 3.2 renames it to "quality and display" in one commit.
- **This box** is TEC-A4D: RTX 2080 Ti (Turing), the spike 0.9 box. P1 measured 8.32 ms p50 at 1080p60 H.264 and 12.10 ms at 4K60 HEVC there (spike 0.9 §6); MoonlightWeb measured P1 3.40 ms and P4 7.67 ms at 1440p on an RTX 5060 Ti at the same QP (research 01:485-497). Node 22.20.
- **NVENC's still-picture refinement** needs the quarter-res two-pass: single-pass leaves QP stuck at 29 instead of reaching 8 (research 01:497). Keep `multiPass` as it is.
- **Encoders and tiers**: Windows chain `nvenc` → `mf-hw` → `mf-sw` (select.rs:43); macOS `videotoolbox` only; Linux ships no streamer (a stub builds). Tiers are per codec class (`apply_tiers` matches on `want.codec`, session/mod.rs:4070-4083), so a pass has two tiers when an H.264 and an HEVC viewer watch at once. The capture thread encodes tiers one after another, and NVENC's encode waits for its completion event on that thread (~4395). `ctx.backend` is an `Option<&'static str>`: `"nvenc"`, `"mf-hw"`, `"mf-sw"`, `"videotoolbox"`.
- **Two budgets, two words**: the glossary's "encoder budget" is the count of encode sessions a machine can open (`select::budget`, session/tiers.rs D14); the gate's 12 ms is the "encode-time budget" (`gate::ENCODE_TIME_P50`).
- **Every rung move is a new encoder and an IRAP**: `TierPass::retarget` drops the encoder on any change of width, height or fps (session/mod.rs:4031-4054); `LadderChange::needs_new_encoder` only says whether the size must be re-planned (governor.rs:337-342).
- **The download host** refuses a re-upload of a published version (409 `installer_published`): a fix after 7.1's upload is 4.1.29.

## Commands

- Web unit and static: `cd web && npx jest <files>`, `npx eslint <files>`, `npx tsc --noEmit` (app code only; tests and e2e are excluded from tsconfig).
- Web e2e, one task per wave: `cd web && npm run e2e:build`, then from the repo root `firebase emulators:exec --only auth,firestore,storage --project demo-playwright-e2e "cd web && npx playwright test --project=chromium e2e/specs/swoop"`. `/preflight` before any push.
- Streamer, this box, in `agent/swoop`: `cargo clippy --all-targets -- -D warnings`, `cargo test --locked`; with `$env:CMAKE_POLICY_VERSION_MINIMUM='3.5'`, the same two with `--features audio-opus`; hardware: `cargo test -- --ignored nvenc --test-threads=1 --nocapture`, `cargo test --lib -- --ignored mf_hw --test-threads=1 --nocapture`, `cargo test -- --ignored scale --nocapture` (add `--release` for the CPU timing).
- Every swoop invocation CI runs (rust-build.yml): Windows (:117-143) `cargo clippy --all-targets -- -D warnings`, `cargo test --locked`, and with `CMAKE_POLICY_VERSION_MINIMUM=3.5` the same two with `--features audio-opus`; macOS (:271-278) `cargo clippy --all-targets --no-default-features --features encode-videotoolbox,audio-opus -- -D warnings` and `cargo test --locked --no-default-features --features encode-videotoolbox,audio-opus`; Linux (:280-287) `cargo clippy --all-targets --no-default-features -- -D warnings` and `cargo test --locked --no-default-features`; plus the macOS sidecar build (:216-222) `cargo build --release --locked --no-default-features --features encode-videotoolbox,audio-opus`. The swoop-posix job sets `CMAKE_POLICY_VERSION_MINIMUM=3.5` for all of its steps.
- Mac (TEC-MBA): `git push mba <branch>`, then `ssh -o BatchMode=yes rosco@192.168.88.46 'zsh -lc "cd ~/src/owlette && git fetch && git checkout <branch> && git pull && cd agent/swoop && <command>"'`. GUI apps (Safari) and signing run as LaunchAgent jobs in the owner's GUI domain (`launchctl bootstrap gui/$(id -u) <plist>`), never over plain ssh.
- Kiosk VM: read its IP from `Get-VMNetworkAdapter`, `git push kiosk <branch>`, then ssh as memory `reference_kiosk_vm.md` describes.
- Probe: `node agent/swoop/spikes/smooth-probe/server.mjs` (port 17460), then `node agent/swoop/spikes/smooth-probe/drive.mjs matrix --seconds 5 --source 1920x1080 --box 1000x562` or `drive.mjs latency --shots 30 --source 3840x2160 --box 1300x731`; results in its `runs/`.
- Dev API (read-only, no ask needed): curl with `x-api-key: $OWLETTE_API_KEY` against `$OWLETTE_DEV_API_URL` from the main checkout's `.claude/.env.local`; `GET /api/health`, `GET /api/installer/latest`. Any mutating call (an update command to a machine, installer finalize, set-latest) waits for the owner's word.

## Environment notes

- A new worktree needs its own `npm ci` in `web/` and `desktop/` (Turbopack rejects a node_modules junction) and a cold cargo build (5–10 min).
- Late `ERR_ADDRESS_IN_USE` or stuck-loading failures in a long local Playwright run are this box's small ephemeral port range: rerun after TIME_WAIT drains. One Playwright rig at a time.
- Only one session builds on the MBA and on the kiosk VM at a time. The MBA's non-login shells lack PATH: wrap in `zsh -lc`. The kiosk VM's IP moves: read it first. The kiosk VM has no GPU (llvmpipe).
- Text that mentions mass deletes inside a Bash command, an ssh string or a heredoc trips the delete guard; write such text to a file with the Write tool. Heredocs collapse double backslashes on this machine.
- The release worktree has no `.claude/.env.local`; source the main checkout's before `upload-installer.mjs` or a dev API call.
- Edge is installed on this box (Playwright's `channel: 'msedge'`); Playwright WebKit is not, and nothing installs it.

## Review fixes applied differently, and why

Both reviews were applied in full; these four fixes took a different form than the one proposed.

1. **The ground-truth latency check is not a self-view.** One review proposed a dev-paired Windows box viewing itself in owlette swoop with an on-screen clock. That cannot run: the streamer ends a session whose viewer reaches it at its own address (`same_machine`). The other proposed spike 0.1's `flip` harness filmed at 240 fps; that needs the harness built on the machine and a slow-motion video the agent cannot step through without a decoder it does not have. In their place: the probe's two barcodes in one screenshot, with and without the canvas, in Edge (4.1, agent-run, the gate), and the owner's ordinary photos of a millisecond clock on the machine's own screen beside owlette swoop (8.1 C), which give the same on − off difference.
2. **"Assert one log line"** is a pure `gate::verdict_line` with unit tests, plus hardware tests asserting the state it reports (one fallback, an IRAP next, a second encoder at P1). The streamer has no test logger (`src/log.rs` installs the rotating file logger from `main` only), and adding one is a new mechanism for one line.
3. **How tiers share the budget**: a defaulted `Encoder::share_encode_time(tiers)` the capture loop calls, so each gated encoder judges 12 ms divided by the pass's tiers. Not an `EncoderConfig` field (13 constructions in 7 source files would move), and not a sum measured per pass (mf-hw encodes asynchronously; only its pump sees an encode's time).
4. **The Mac and the Linux app**: one review asked for Safari and the macOS app against a dev machine. Safari's engine counters (callbacks, frames, drops, draw time) come from the probe in 3.4, opened by a LaunchAgent job, because the app's stats overlay does not show them; owlette swoop on the Mac against dev is the owner's (8.1 D), because its sign-in and passkeys hand off to the system browser (ADR 0012). The Linux app's WebKitGTK is checked through the probe in a WebKitGTK browser already on the kiosk VM, if one is there; its renderer is llvmpipe, which the rule refuses, so a GPU-backed Linux viewer is a Backlog item.

Also changed beyond the reviews, by the same rule: refinement leaves mf-hw (C11), because nothing here can test an Intel or AMD MFT's still-frame behaviour. The draw-time gate the second review asked of the cover check runs in 4.1 instead, under the rule that decisive timing runs alone on the box.

## Next Steps

1. **Gate.** Confirm 4.1.27 is merged into dev, and that no file any task lists has uncommitted or unmerged changes in any worktree (`git worktree list`, then `git -C <path> status --short` in each). At planning time the 4.1.27 worktree (`C:/Users/admin/Documents/Git-restored/Owlette-release-4127-wt`) held an uncommitted kick follow-up that touches `web/e2e/helpers/swoopHost.ts` and both changelogs, among others; it ships in 4.1.27 or moves to its own branch first.
2. **Worktree.** `git fetch origin && git worktree add C:/Users/admin/Documents/Git-restored/Owlette-release-4128-wt -b release/4.1.28 origin/dev`; `npm ci` in its `web/` and `desktop/`.
3. **Keep the plan.** Copy `dev/active/swoop-clarity/` from the main checkout into the worktree and force-add it in the first commit (`git add -f dev/active/swoop-clarity`): `dev/active/` is gitignored, and an untracked plan was lost once.
4. **Run.** From the worktree, `/execute` wave 1 (eight tasks in parallel), then each wave in order. Wave 3's task 3.3 starts only if 2.1's report says the still-frame premise holds. Wave 4 is one task with the box to itself. Wave 7 needs the owner's one go (the dev upload with set-latest, the push, the merge and the tag); wave 8 is the owner's sitting.
5. **Open questions**: plan.md, "Open questions (for the owner)".
