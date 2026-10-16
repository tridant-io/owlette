# Spike 0.2 — macOS capture + TCC (RECONSTRUCTED 2026-09-17)

**Original state: a stub.** The file existed but held no results, because the orchestrator had no Mac [verbatim: W4:4.5 "macos-tcc.md is a stub: no Mac here"]. Its exact stub text is [unknown]. Probably the task's Do / Done-when / Go-no-go copied from `tasks.md`, which is reproduced below [inferred].

**Spike status at the loss: NOT RUN.** The Mac agent ran research only and did not measure capture. Its results went into `dev/handoff/tri-platform-macos.md` §16.3 and the log, not into this file [verbatim: H §16.3 "Amendments to tasks not started (from research, not measured here)"].

## The task (from tasks.md) [verbatim: H §15 Task 0.2]

- Do: on a real Sequoia box, test in order:
  - (a) an ad-hoc-signed Tauri `.app` started by a LaunchAgent, granted Screen Recording, shelling `/usr/sbin/screencapture -x -t jpg`, recording whether TCC attributes the capture to the calling bundle or to `screencapture`;
  - (b) the same app using an in-process ScreenCaptureKit binding;
  - (c) a LaunchDaemon-spawned `python … mss` (expected to fail).
  - For whichever succeeds, re-sign, replace, reboot and re-capture.
  - Also record: (i) child-process TCC inheritance for a binary inside `owlette.app/Contents/MacOS/`, `posix_spawn` from the app vs `launchctl asuser` from the daemon (this decides C2); (ii) the Sequoia 30-day re-authorisation behaviour unattended (Q15); (iii) line counts for the Wave 8 ledger.
  - Plus: which process is TCC-responsible for a managed `.app` launched by the daemon, and whether a disclaiming `posix_spawn` restores its own identity.
- Done when: the file records, for each of (a)(b)(c), granted/denied, time-to-first-jpeg, and whether the grant survived an app replacement **and** a reboot, plus the child-process responsibility answer.
- Go/no-go:
  - (a) works → `capture.rs` of about 90 lines, no new crate.
  - (a) fails and (b) works → about 250 lines plus one crate (owner Q5).
  - Both fail → `capabilities.screenCapture: 0` (owner Q6).

## Evidence gathered since (substitute, not the spike's results)

Research from the Mac on 2026-09-16, **not measured** [verbatim: H §16.3]:
- The Sequoia recurring Screen Recording alert still ships on macOS 26 (**Allow** / **Open System Settings**). Since 15.1 its date is refreshed by use, so it returns after about 30 days without a capture. Test by moving a VM's clock past 31 days.
- `/usr/sbin/screencapture` carries `com.apple.private.tcc.check-allow-on-responsible-process`, so TCC checks the app that spawns it. That supports decision 5's shell path, i.e. go/no-go (a).
- `CGPreflightScreenCaptureAccess` can stay stale until the app relaunches. `tcc.rs` should publish `screen_recording: true` only on a preflight **and** a recent capture with real content. ScreenCaptureKit's -3801 is the denial. `CGWindowListCreateImage` is obsoleted in the 15 SDK.
- MDM PPPC cannot grant ScreenCapture. `forceBypassScreenCaptureAlert` (15.1+, MDM only) hides the alert, with no evidence either way for 26.
- A daemon must never capture.
- Local Network privacy: LaunchAgents are not exempt, so keep LAN work in the daemon and add `NSLocalNetworkUsageDescription`.

Measured on the Mac (macOS 26.6, 25G72), relevant to (ii) and to the mirror question [verbatim: H §16.2]:
- A managed app spawned as a launchd job in `gui/<uid>` is its own TCC-responsible process: `responsibility_get_pid_responsible_for_pid(pid) == pid`, measured non-root in the user's own GUI domain. The disclaiming `posix_spawn` was dropped for that reason.
- Whether the app's TCC prompt names the app rather than owlette's python, when the daemon spawns it as root, is **unverified** (H §16.4 item 1).

Daemon-side contract already shipped, which `tcc.rs` (Task 4.4) must write to [verbatim: H §16.2]:
- `ipc/tcc.json` = `{"screen_recording": bool, "checked_at": <unix seconds>}`, owned by the console user, with no group or world write bit, at most 300 s old.
- A fresh `false` refuses capture with `screen_recording_not_granted`. No report lets the app's job runner answer. `streamer_capable()` is a fresh `true`.

## Still owed (the whole Done-when)

(a)/(b)/(c) results, grant survival across replacement and reboot, the child-inheritance answer for C2, the 30-day behaviour, and line counts. All [unknown] until someone runs it on the Mac.

## Measured 2026-09-25 on the MacBook Air (macOS 26.6 25G72, arm64), over ssh from the dev box

Stub: `~/src/spike-tcc/SpikeTCC.app` — a 60-line Swift binary in a bundle (`app.owlette.spike-tcc`,
`LSUIElement`), **ad-hoc signed**, installed as a LaunchAgent in `gui/<uid>` (`RunAtLoad`). One run =
one process: it logs the TCC-responsible pid, calls `CGPreflightScreenCaptureAccess` and
`CGRequestScreenCaptureAccess` once, then (a) shells `/usr/sbin/screencapture -x -t jpg` and
(b) asks `SCShareableContent` (ScreenCaptureKit), retrying for a minute. Log: `~/Library/Logs/spike-tcc.log`.

| step | result |
|---|---|
| responsible process | `responsibility_get_pid_responsible_for_pid(pid) == pid`: the LaunchAgent-started app is its own TCC identity |
| `screencapture` from an ssh session (sshd responsible) | refused at once, no prompt: "could not create image from display" |
| (a) before any grant | refused in ~90 ms, **no prompt**: `screencapture` only checks the responsible app, it never asks |
| the ask | `CGRequestScreenCaptureAccess()` raises the prompt and lists the app under Screen & System Audio Recording; it returns `false` until the next launch |
| (a) with the grant, first attempt after relaunch | `exit 0`, **348 ms** to a 549 KB JPEG, **3420×2214** (physical pixels of the retina panel) |
| (b) with the grant | `SCShareableContent` ok in **77 ms**: 1 display, 276 windows |
| (b) without the grant | error "The user declined TCCs for application, window, display capture" in 5–15 ms — the precise state, unlike `screencapture`'s one message |
| child-process responsibility | the shelled `screencapture` ran on the **app's** grant: a child of the LaunchAgent app inherits the app's TCC identity (answers (i) for the app-spawned case) |
| grant survival across **replacement** | **dies with an ad-hoc signature.** Rebuilding the same bundle (new cdhash) left Settings showing the row ON while every call was refused as "declined"; `tccutil reset ScreenCapture app.owlette.spike-tcc` + a fresh ask + a new grant fixed it. A Developer ID signature has a stable designated requirement and is what the real app must carry (Wave 5); an unsigned dev build will lose the grant on every rebuild |
| grant survival across **reboot** | not yet run (needs the owner's ok to reboot the laptop) |
| (c) LaunchDaemon-spawned `python … mss` | not run: needs root on the laptop; research says it fails and nothing here contradicts it |
| the 30-day recurring alert | not observable in one evening |
| prompt discipline | retrying an undetermined app re-prompts on **every** attempt (twelve prompts in a minute). `capture.rs` must ask once per launch and then only preflight until relaunch |

**Go/no-go: (a) works → `capture.rs` ≈ 90 lines, no new crate**, with two rules from the table: ask once
per launch, and ship a Developer ID signature or expect the grant to vanish on every update.
Line count of the stub as a size reference: 60 lines of Swift for ask + shell + measure.
