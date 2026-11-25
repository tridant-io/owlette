# swoop at the macOS login window: plan
**Created**: 2026-11-25 | **Status**: Draft, for the owner. Nothing here is approved.

The owner ruled on 2026-11-25 that swoop must also reach a Mac at the **login window**: after a reboot, after a log
out, and with FileVault where Apple allows it. This plan reverses decision 9 of `dev/completed/swoop-macos/plan.md`
(`:136-138`, "No login-window control (Apple)") and the docs that follow from it (`web/content/docs/dashboard/swoop.mdx:25`
and `:302`). It does **not** reverse ADR 0009. That ADR already sets the login screen, the lock screen and UAC as
the bar, with no macOS exception (`docs/adr/0009-swoop-is-our-own-webrtc-streamer.md:3`). The macOS plan narrowed
that bar without saying so in the ADR, and this plan amends the ADR's macOS story to match what ships (draft text below).

Line numbers are read at `origin/dev` `22128da4` (4.2.5). Tags: **[D]** documented by Apple or in a vendor's source
or docs; **[I]** inferred from a forum post, a vendor's behaviour or reasoning; **[M]** measured in this repo;
**[U]** unmeasured, and the spike's job.

## Summary

At the login window there is no user session, so neither the desktop app nor its streamer exists. Apple's supported
shape for remote access there is a **pre-login launchd agent**: a plist in `/Library/LaunchAgents` with
`LimitLoadToSessionType = LoginWindow`. macOS runs it **as root** while the login window is up and kills it at
login. The plan adds one, `app.owlette.loginwindow`, which runs the app's own executable in a headless runner mode.
That runner starts the streamer as its child, the same way the app does in a user's session, over a socket only
root can reach. A sign-in or sign-out swaps one streamer for the other. The viewer reconnects through the existing
`restart` path rather than following a desktop switch the way Windows does.

Two unknowns decide whether this works:
- does macOS credit the app's Screen Recording and Accessibility grants to the same app running as root before login;
- do injected keystrokes reach the login window's password field (Apple's open bug r. 5636091).

Both may need Apple's `persistent-content-capture` entitlement or a DTS incident. So a **spike on the real Mac comes
before any product code**, with a go/no-go after it.

**FileVault's unlock screen stays out of reach.** It comes before macOS starts, and nothing of ours runs there.

Budget after a go: about 2,500 lines with tests, plus about 700 if capture at the login window needs a
CGDisplayStream fallback.

## What the research established

### Today's macOS chain [M]
- **Who launches the streamer.**
  - The root LaunchDaemon `app.owlette.agent` (`agent/packaging/macos/app.owlette.agent.plist:13-25`) never starts
    the streamer itself.
  - `swoop_spawn_posix.spawn` (`agent/src/swoop_spawn_posix.py:276-328`) binds `ipc/swoop/<id>.sock`, mode 0660
    root:_owlette (`:56`, `_listen` `:366-385`). It then drops a `launch` job through `osadapter.run_job`
    (`agent/src/osadapter/posix.py:240-300`).
  - `run_job` fails closed with `desktop_not_running` when the app's pid file is absent (`posix.py:270`,
    `_desktop_pid` `:1065-1069`).
  - The desktop app's runner (`desktop/src-tauri/src/jobrunner.rs`) honours a `launch` only for a root-owned
    request (`:526`, `launch` `:305-320`).
    - The program must be `owlette-swoop`, resolved next to `current_exe()` (`:56`, `:492-495`).
    - The args come from an allow-list (`:57`).
    - The socket must be uid 0's and not world-writable (`check_socket` `:395-407`).
  - The runner spawns the sidecar in **its own process group** (`:432-433`), with stdin and stdout on the
    daemon's socket.
- **Back in the daemon.**
  - It admits the connection only from a peer whose uid is the console user's (`swoop_spawn_posix.py:308-312`,
    `_peer_uid` `:448-457`).
  - It pins the pid only if that process runs as the console user (`_pin` `:460-469`).
- **The capability gate.**
  - `capabilities.swoop` is 1 when the binary is present and `osadapter.streamer_capable()` says yes
    (`agent/src/swoop_capability.py:19-49`).
  - On macOS that is a fresh `screen_recording: true` in `ipc/tcc.json` (`darwin.py:337-340`, `:944-985`).
    - The report must be the console user's own file and under 300 s old (`:172-173`).
    - The app writes it as `{"screen_recording", "accessibility", "checked_at"}` (`desktop/src-tauri/src/tcc.rs:202-204`).
- **Every gate that excludes the login window today.** Each one is a place this plan has to change.
  - `darwin._NOT_A_LOGIN = {'root', 'loginwindow'}` (`darwin.py:142-145`).
  - `_console_session` drops uid 0 and the login window (`:728-761`), so `console_user()` is `None`
    (`posix.py:197-205`).
  - `_screen_recording_granted` returns `None` with no console user (`darwin.py:952-954`). So **the heartbeat
    advertises `swoop: 0` at the login window** and the dashboard hides swoop (`MachineCardView.tsx:475`,
    `SwoopPicker.tsx:336`).
  - `_run_job` refuses with no app pid (`posix.py:270`).
  - The spawn admits only a console-user peer and pid (`swoop_spawn_posix.py:308-312`, `:460-469`).
  - The web leaves `desktop_not_running` out of its stop list on purpose (`web/lib/swoop/machineFailure.ts:11-15`),
    so a viewer at a login-window Mac keeps retrying.
- **The pkg.**
  - `build.sh` copies the two plists (`agent/build/macos/build.sh:127-128`).
  - The sidecar rides inside `owlette.app` as Tauri's `externalBin` and is signed with the app
    (`desktop/src-tauri/tauri.macos.conf.json`).
  - `postinstall` bootstraps the daemon (`scripts/postinstall:59-69`), and the app only into the console user's
    `gui/<uid>` (`:70-77`).
  - `preinstall` boots the app out of every `gui/<uid>` and `pkill`s `owlette-desktop` (`scripts/preinstall:32-39`).
  - The app's plist is `Aqua` only: "there is no tray to draw at the login window"
    (`app.owlette.desktop.plist:4-9`, `:31-32`).
- **What M0 proved.** A child the app spawns gets the app's Screen Recording, Accessibility and Local Network
  grants (`dev/completed/swoop-macos/spikes/3.1-gate-m0.md`, go on 2026-09-30).
- **The lock screen inside a session was never run** (`spikes/6.1-first-mac-picture.md:28`). The owner's belief
  that it already works is unmeasured.
- **The input path.**
  - Input posts at `CGEventTapLocation::HIDEventTap` from a `HIDSystemState` source (`agent/swoop/src/input/mac.rs:392`, `:438`).
  - A session wakes the display with `IOPMAssertionDeclareUserActivity` and holds it while capturing
    (`agent/swoop/src/platform/macos.rs:128-178`).
- **Sleep with nobody logged in.** The daemon holds system sleep, which works with nobody logged in. Only the
  user's session can hold the idle lock (`desktop/src-tauri/src/awake.rs:4-5`). The keep-awake-on-mains change
  (`origin/feat/machine-sleep`) is what keeps a login-window Mac online.
- **The Windows reference.**
  - The streamer runs as SYSTEM in the console session (`agent/src/swoop_spawn.py:351-384`).
  - Capture and input each follow the input desktop on their own thread (`agent/swoop/src/securedesk/mod.rs:1-14`).
  - A lock or UAC switch recovers in 114-199 ms with 0-3 blank frames (`dev/active/swoop/spikes/0.3-system-spawn-secure-desktop.md`,
    §7.1e).
  - The viewer never reconnects for those.

### Running in the LoginWindow session
- **[D] A daemon cannot reach the window server.**
  - TN2083: a daemon "is not allowed to connect to the window server". "If you need to connect to the window
    server in a pre-login context, create a pre-login launchd agent."
  - Pre-login agents run as root, and launchd ignores `UserName` for them (PreLoginAgents Read Me).
  - `launchctl(1)`: "LoginWindow agents are loaded when the LoginWindow UI is displaying and currently run as root."
- **[D] Lifecycle around a login.**
  - With `[Aqua, LoginWindow]`, the login-window instance is terminated at login and a second instance starts in
    the user's session (TN2083).
  - With `LoginWindow` alone, only the first half happens.
  - Under fast user switching a pre-login instance "may or may not" be spun up in between (Quinn, Apple DTS,
    forum 763453) [I].
- **[I] Agents do the capture, daemons do not.** Apple DTS (forum 814152, Jan 2026): "Daemons should not be messing
  around with GUI stuff, and that includes ScreenCaptureKit… The agent does all the GUI stuff, like record the
  screen and post keyboard and mouse events."
- **[I] No `launchctl` domain for the login window** (`launchctl(1)` lists system, user, login, gui and pid).
  - RustDesk loads its pre-login agent with `launchctl load -w -S LoginWindow` (`src/platform/macos.rs`).
  - How our pkg loads it with the login window already up is **[U]**.
- **[I] One pre-login agent failed to appear after a reboot** but did after a logout (Big Sur, forum 682240). DTS
  fixed it privately.

### Capture at the login window
- **[I] ScreenCaptureKit, from Apple DTS on the forums:**
  - Jun 2024 (thread 756908): "ScreenCaptureKit is not available in the pre-login context (r. 113021168)".
  - Jan 2026 (thread 814152, fetched directly): "In macOS 14.4 we fixed a bug that prevents you from using
    ScreenCaptureKit in the pre-login context (r. 121253782)". Quinn "prototyped this approach using
    ScreenCaptureKit and it works as expected on macOS 14.4 and later". Before 14.4, `CGDisplayStream`.
  - One Sequoia report (thread 768146) says SCK, CGDisplayStream and AVCaptureScreenInput all failed pre-login,
    even from a pre-login agent. DTS pointed at the `persistent-content-capture` entitlement. Unresolved.
  - Nothing covers macOS 26 or 27.
- **[D] The older APIs.** macOS 15 deprecates `CGDisplayStream` and `CGWindowListCreateImage`, and they "can
  trigger system alerts" (macOS 15 release notes, 120910350). `CGDisplayCreateImage` is obsoleted in the 15 SDK [I].
- **[I] Preflight is not proof.** One report saw only the wallpaper in login-window frames while
  `CGPreflightScreenCaptureAccess` returned true (thread 713396). So the spike must judge pixels, not booleans.
- **[D] Chrome Remote Desktop's Mac host.**
  - It installs one agent with `LimitLoadToSessionType = [Aqua, LoginWindow]`
    (`remoting/host/installer/mac/LaunchAgents/org.chromium.chromoting.plist`) and a root broker daemon.
  - By default it captures through WebRTC's `ScreenCapturerMac` (CGDisplayStream). SCK is opt-in
    (`desktop_capture_options.h`, `allow_sck_capturer` false).
  - Its **curtain mode** refuses the login window as root: "Connecting to the console login session is not yet
    supported", in `SessionWatcher::ActivateCurtain()`, reached only from `CurtainModeMac::Activate()`
    (`remoting/host/curtain_mode_mac.cc`, fetched directly).
  - Its host skips the permission wizard as root: "the permission wizard is not actionable at the login screen"
    (`remoting/host/mac/host_service_main.cc`).
- **[D] RustDesk ships the same shape.**
  - Root daemon `com.carriez.RustDesk_service`.
  - Agent `com.carriez.RustDesk_server` with `LimitLoadToSessionType` LoginWindow + Aqua, running the app's **main
    executable** (`RustDesk --server`) in both contexts.
  - Capture is CGDisplayStream (`libs/scrap/src/quartz/capturer.rs`).
- **[D] Other vendors.**
  - AnyDesk: "Added support for connections to the login screen" (4.0). It also logs regressions on every major:
    8.1.2/8.1.3 for Sequoia, 9.6.4 (Mar 2026) for Tahoe (changelog).
  - Jump Desktop Connect reaches the login window and says virtual displays are not available there: use an HDMI
    emulator (docs.jumpdesktop.com).
  - Parsec needs "FileVault disabled" and a wired network for its login screen.

### TCC for a root process before login, and MDM
- **[D] MDM cannot grant capture.** PPPC (`com.apple.TCC.configuration-profile-policy`): ScreenCapture and
  ListenEvent "A profile can't grant access… it can only deny it". The only other value is
  `AllowStandardUserToSetSystemService`.
  - Accessibility and PostEvent can be granted by MDM.
  - Accessibility is marked deprecated in macOS 27 in favour of declarative app settings (Apple's device-management
    YAML).
- **[D] Vendors agree.**
  - TeamViewer: "Your users will still need to grant Screen Recording access themselves".
  - Splashtop: "Jamf can NOT automate allowing Accessibility, Screen Recording".
  - Jump: someone has to be at the Mac.
- **[D] The entitlement.** `com.apple.developer.persistent-content-capture` "enables VNC apps to view and record the
  screen", macOS 14.4+, and must be applied for. Restricted entitlements need a provisioning profile embedded in
  the app [I].
  - Jump and TeamViewer cite a "Remote Desktop" grant on macOS 14+ for unattended access.
  - Splashtop says that on macOS 27 its setup "shows Remote Desktop instead of Screen Recording".
  - That suggests Apple is moving remote-control apps onto that entitlement-backed grant [I].
- **[U] No source says whether a Screen Recording or Accessibility grant made in a user's session covers the same
  app running as root before login.** Two indirect signals say it does [I]:
  - RustDesk runs the same main executable in both contexts and documents only the in-session grants.
  - Screen Recording and Accessibility live in the system TCC database (forum 730043).
  - Splashtop says grants "only apply to the user account on which they are granted" [D], which points the other way.
  - **This is the spike's first question.**

### Input at the login window
- **[I] Apple's bug.** Apple DTS (forum 726470, 2023): clicks and keys failing at the login window are a "known issue
  with the pre-login context (r. 5636091)". The workaround is given only through a DTS incident.
  - The PreLoginAgents Read Me [D]: "CGEventTaps do not work by default in the pre-login environment".
  - The CRD team (2017) said the same and pointed at a `CGPreLoginApp` Mach-O section [I, unverified spelling].
- **[D] Secure input.** TN2150: secure input stops delivery to intercepting processes (taps, `GetKeys`). It says
  nothing about posting.
- **[I] Typing a password works for vendors.**
  - RustDesk's #11802 was a regression in typing at the login screen on 15.4.1, fixed in May 2025. So typing a
    password there works.
  - AnyDesk 9.0 added "copy-paste passwords into the remote Login Screen".
- **[D] CRD posts at `kCGSessionEventTap`, and mouse events through the deprecated `CGPostMouseEvent` up to macOS
  26** (`input_injector_mac.cc`). Ours posts at the HID tap (`input/mac.rs:438`), like RustDesk.

### FileVault
- **[I] Nothing third-party runs before the unlock.** At boot, before the data volume is unlocked, only Apple's
  pre-boot authentication runs. Our daemon, our agents and our app all live on that locked volume.
- **[I] The default skips the login window.** The unlock credential logs the user straight in (FDE auto-login), so
  **after a reboot there is normally no login window to reach**. `DisableFDEAutoLogin` makes the login window
  appear (Apple DTS, forum 800854).
- **[D] Two Apple ways through, neither ours.**
  - `fdesetup authrestart` restarts "bypassing the initial unlock", needs root and a credential, and reduces
    protection for that boot (`fdesetup(8)`).
  - macOS 26 on Apple silicon: "FileVault can now be unlocked over ssh after a restart if Remote Login is enabled
    and a network connection is available" (support.apple.com/en-us/124963). Wi-Fi support differs by point
    release [I]. Whether the Mac then shows the login window or logs straight in is **[U]**.
- **[D] Vendors.**
  - Jump: "a user at the Mac must unlock the disk after a restart", or `sudo fdesetup authrestart`.
  - Splashtop: only its own "Restart system with FileVault password".
  - AnyDesk: "Remote Restart support for Macs with FileVault enabled".
  - No vendor connects at the FileVault screen itself.

## Approach

```
root daemon app.owlette.agent (launchd system domain)
  | reads IOConsoleUsers in-process: who is on the console - a user, the login window, or nobody
  |
  |-- a user is on the console -> today's path, unchanged:
  |     ipc/jobs (0770 root:_owlette)  ->  owlette.app, gui/<uid>, as the console user  ->  owlette-swoop run
  |     socket ipc/swoop/<id>.sock 0660 root:_owlette, peer = console uid
  |
  '-- the login window is on the console -> new:
        ipc/loginwindow/jobs (0700 root:wheel)  ->  owlette-desktop --loginwindow     ->  owlette-swoop run
        (the pre-login LaunchAgent app.owlette.loginwindow, which macOS runs as root;     (its child: the app's TCC identity,
         headless, the launch runner only; never a window, a tray or a prompt)            as root; no clipboard, no audio)
        socket ipc/loginwindow/<id>.sock 0600 root:wheel, peer uid 0, pid pinned by exe path and parent

on a console change (log in, log out, fast user switch) the daemon sends the streamer whose context left the console
{"type":"kill","reason":"console_change","context":"loginwindow"|"user"} (context = what the console switched TO);
the streamer byes its viewers `restart` carrying that context, and each viewer starts its next session at once,
which lands on the other path.
```

| piece | today | this plan |
|---|---|---|
| `agent/packaging/macos/` | daemon plist; app plist (`Aqua`) | plus `app.owlette.loginwindow.plist`: `LimitLoadToSessionType` `LoginWindow`, runs `owlette.app/Contents/MacOS/owlette-desktop --loginwindow` |
| `postinstall` / `preinstall` | daemon; app into the console user's `gui/<uid>` | the root-only `ipc/loginwindow` dir; load and unload of the new agent with the command the spike measures |
| `desktop/src-tauri` | Tauri app; `jobrunner` serves `ipc/jobs` | `--loginwindow` branches in `main()` before `tauri::Builder`. It serves `ipc/loginwindow/jobs` with the same `launch` contract. Owner uid 0, socket uid 0, args exactly `run --loginwindow`. It writes a root-owned state report, and refuses to run from a bundle anyone but root can write. Every refusal exits 0, so `KeepAlive {SuccessfulExit: false}` does not respawn it every 5 s |
| `osadapter/darwin.py` | `console_user()`: a user or `None` | plus `console_context()`: `user` / `loginwindow` / `None`, from the same `IOConsoleUsers` read |
| `osadapter/posix.py` | `run_job` into `ipc/jobs`, app pid file | `run_job` takes the queue; the login runner's liveness is its own root-owned pid file |
| `swoop_spawn_posix.py` | console-user socket and peer | routes by context; login-window socket 0600 root in the root-only dir; peer uid 0; pid pinned by the uid the runner launches as (0, or the role account if gate S proved one), exe path and parent pid |
| `swoop_manager.py` | kills on `kill` / revoke / exit | plus a console-change watch that kills the out-of-context streamer (`console_change`); an ensure during a switch waits, bounded, for the target runner |
| `swoop_capability.py` / `darwin.py` | `swoop: 1` from the user's `tcc.json` | at the login window, from the login runner's root-owned report; advertised only on the macOS majors a gate has measured |
| `agent/swoop` (streamer) | one context | `run --loginwindow` (explicit, never inferred from the uid): clipboard and audio off. A `kill` with reason `console_change` byes `restart` carrying the kill's `context`; no other `bye` carries one |
| `web/` viewer | `restart` reconnects on the growing delay | a `restart` with `context` reconnects at once, with its own line ("switching to the login window" / "switching to the signed-in desktop"). The picture itself shows the login window, so the page gets no other label: `status` reaches the agent, not the page |
| docs, ADR | "someone must be logged in" | the login window works, its limits, FileVault, the ADR 0009 amendment |

## Decisions

1. **The pre-login process is a separate LaunchAgent that runs the app's main executable headless.**
   - It is not the Tauri UI as root, and not the sidecar launched by launchd.
   - Reason, on TCC [I, spike checks]: TCC keys grants on the responsible code's identity. The app's main executable
     is `app.owlette.desktop`, the identity the person already granted, which RustDesk relies on too. A sidecar
     launched by launchd would be its own responsible process with its own identity, so it would need two more
     grants per Mac, added by hand from inside the bundle.
   - Reason, on the label [M]: a separate label leaves `app.owlette.desktop.plist`, the tray's start-at-login
     toggle (`startup_link.rs:104`, `system-tray.mdx:75`) and the single-instance plugin (`lib.rs:71`) untouched.
   - Reason, on the branch point: the headless branch comes before `tauri::Builder`, so no window, tray, webview or
     plugin exists as root.
   - **If the spike finds the app identity is not credited at the login window but a sidecar identity granted on its
     own is, this decision flips. Gate S decides.**
2. **The daemon still never captures.** TN2083 [D] and Apple DTS [I]: GUI work belongs to an agent. The streamer
   stays a child of a runner in the right session, as in M0.
3. **The login-window path gets its own root-only directory, and nothing gets wider.**
   - The queue, socket and reports live in `ipc/loginwindow/`, 0700 root:wheel.
   - Jobs are honoured only as root-owned files there. The socket is 0600 root, and the peer must be uid 0.
   - The `_owlette` group and the console user gain nothing: they cannot see, write or connect to any of it.
   - Uid 0 is everyone root, so the pin is stronger than today's: uid 0, the installed sidecar's path (`psutil`
     `exe()`) and the runner's pid as parent.
4. **The streamer runs as root at the login window. This is the risk ADR 0009 already accepts for SYSTEM on Windows.**
   - launchd will not drop a pre-login agent's uid [D].
   - Whether the runner can start the streamer as an unprivileged role account and keep capture and input is a
     spike step (`spawnchild-as nobody`, Task 0.3 step 3). If it can, that is the design. If not, root is the
     accepted risk, written into the ADR.
   - Either way the streamer learns its context from its arguments (`run --loginwindow`), never from its uid.
5. **The lock screen stays the user session's job.** The lock screen belongs to the user's own window-server
   session [I, DTS 763453], so the user's streamer already covers it if capture and input work there. The spike
   checks it, since it was never run (`6.1-first-mac-picture.md:28`). A failure there is its own finding, not this
   plan's scope.
6. **A sign-in or sign-out swaps the streamer, and the viewer reconnects. There is no desktop following as on
   Windows.**
   - launchd kills the pre-login agent at login [D]. The user's app starts on its own a few seconds later.
   - The runner spawns the streamer in its own process group (`jobrunner.rs:433`), so the daemon kills it on the
     context change rather than trusting launchd to take it.
   - The runner also kills its child on SIGTERM.
   - Only the daemon knows what the console switched to, so its kill line names it:
     `{"type":"kill","reason":"console_change","context":"loginwindow"|"user"}`.
   - The streamer byes viewers `restart`, the existing "come back" path (`PROTOCOL.md:395-398`, `:409-410`),
     carrying that `context`. That field is additive, and older pages ignore it.
   - No other `bye` carries `context`, so an ordinary agent restart keeps today's behaviour.
   - The page starts its next session at once, without the growing delay, and a step-up inside its 7 days is not
     asked again.
   - A console-change restart does not count toward the spawn-rate ceiling.
   - Creating a session checks that the machine is `online`, not `capabilities.swoop`
     (`web/app/api/sites/[siteId]/machines/[machineId]/swoop/sessions/route.ts:267`). So the capability dipping to
     0 for a heartbeat during the swap hides the dashboard's button, but does not refuse the reconnect.
   - Rejected alternative: one long-lived root network process that keeps the WebRTC peer and moves only capture
     and input between sessions over IPC. That is seamless, but it is a second architecture with a root network
     daemon, far beyond this plan.
7. **The login runner never asks for a grant.** It only preflights. It calls none of `CGRequest*`, `selfcheck
   --force` or `--paste-once`, and its arg allow-list is `run` alone. This follows CLAUDE.md's "never raise a prompt
   unattended", and nobody is there to answer one anyway.
8. **Clipboard and audio are off at the login window.** Windows keeps the clipboard away from its security screens
   (`swoop.mdx:178`), and the login window has nothing to hear. Typing a password stays possible, pasting one does
   not.
9. **Capability at the login window comes from the login runner's own report.**
   - The report is root-owned, under `ipc/loginwindow/`, and fresh within the same 300 s.
   - Its content is decided after the spike. If preflight predicts pixels there, preflight is enough. If not, the
     runner's start-up check captures one frame.
   - The capability is advertised **only on the macOS majors a gate has measured**: 26 after the spike, 15 and 27
     only after their own run. AnyDesk shipped login-window fixes for both 15 and 26 [D], so a major is not a
     safe assumption.
10. **FileVault is documented, not engineered.**
    - Before the unlock nothing of ours can run. After a person unlocks (at the Mac, or over ssh on macOS 26 Apple
      silicon), swoop reaches whatever the Mac lands on: the user's session (default auto-login) or the login window.
    - An owlette "restart and unlock" built on `fdesetup authrestart` would make the agent hold or relay a FileVault
      credential, a new class of secret. It is not proposed. An admin can run `fdesetup authrestart` over ssh
      themselves before a planned reboot.
11. **Same policy switches as today.** A login-window session sits behind the site's swoop switch and the control
    step-up, and every row is audited.
    - The server writes the session's start row before the machine has answered, so it cannot know the context
      (`sessions/route.ts:340-359`, `audit_unavailable`). The context therefore rides the agent's own
      `session_started` event (`web/app/api/agent/swoop/events/route.ts:57`) as `context: loginwindow`, so a
      review can tell such a session apart.
    - The login window shows no user data, and signing in needs the password.
    - A separate opt-in is the owner's call (owner decision 5).
12. **The upgrade path is the pkg's.** The new plist and directory come with the pkg, and `postinstall` (the new code
    an old Mac runs) loads the agent. That holds on a self-update with nobody logged in too, using the command the
    spike measures. Verified by upgrading from 4.1.0, the oldest Mac release, at the login window (CLAUDE.md: "A
    fleet-behavior fix must cover the upgrade path").

## Risks, spikes first

**Spike S: capture and input at the login window on the real Mac, before anything is built.**
- **The rig.** The MacBook Air rig (macOS 26.6 arm64, signed `owlette.app` installed, ssh with sudo for the agent,
  per `reference_mba_access`).
- **The probe.** Spike-only code: a tiny `owlette-lw-probe.app`, Developer ID signed, hardened runtime, notarized,
  installed in `/Applications`.
- **How it runs.** A pre-login + Aqua LaunchAgent runs it. A second LoginWindow-only plist runs the **installed
  product's** `owlette-swoop selfcheck` as the sidecar-identity control.
- **What it proves:**
  - pixels: a saved PNG that shows the login UI, judged by eye;
  - typed characters and clicks landing;
  - where each grant is credited;
  - the hand-off timings;
  - the console registry in each state;
  - the lock screen;
  - the cold-boot case;
  - where FileVault unlocks land.
- **What it cannot prove.** The probe is not `owlette.app`. It proves the mechanism with the same team and signing
  type, under a different bundle id. **Gate G** proves the product before release.
- Every step and the single sitting are in Task 0.3 of [tasks.md](tasks.md).

### Go / no-go after Spike S (owner reads the memo)

| outcome | verdict | what follows |
|---|---|---|
| SCK frames show the login UI and keys and clicks land, on the grants the person made in their session for the same app identity | **go** | Waves 1-4 as written |
| Same, but only once the probe (or sidecar) identity got its own grants | **go, one extra step per Mac** | decision 1 flips to the identity that worked; the banner and docs gain the step; owner accepts the per-Mac cost |
| SCK fails pre-login but CGDisplayStream frames show the login UI | **go with a fallback, owner decides** | a CGDisplayStream backend for the login window only (+~700 lines), deprecated API, may raise alerts or vanish in a later macOS |
| Pixels fine, injected input does not reach the login window | **wait for Apple** | owner files a DTS incident for r. 5636091; view-only at the login window is possible meanwhile, but viewing alone does not meet the bar, so ship nothing until the owner chooses |
| No pixels by any API | **wait for Apple** | owner applies for `persistent-content-capture` (if not already) and the spike reruns when Apple answers; if it still fails, swoop-macos decision 9 stands and the docs say why |

The result counts for macOS 26 only. Each other major needs its own run before decision 9's capability gate opens
there.

### Risks
1. **The TCC carry-over is unmeasured** [U]. This is the hardest unknown, and it is the spike's question 1.
2. **Input at the login window is an open Apple bug** (r. 5636091) [I]. The fix may be private, through DTS.
3. **SCK at the login window has broken and been fixed across majors** (r. 113021168 → 121253782; AnyDesk on 15 and
   26) [I/D].
   - It can break again on any macOS update with nothing in our code changing.
   - The capability is per measured major (decision 9), and the release checklist reruns the gate on each new major.
4. **macOS 27 may move remote control onto the entitlement-backed "Remote Desktop" grant** (Splashtop [D];
   reading [I]).
   - That would touch in-session swoop too, not only this plan.
   - The entitlement request (owner ask 3) covers both. Lead time is Apple's.
5. **The monthly Screen Recording re-confirm alert** (macOS 15.1+) appears only in a user's session.
   - Whether a pending re-confirm blocks capture at the login window is [U].
   - The entitlement removes the alert [D].
6. **Headless Macs.** A Mac mini with no display shows nothing to capture at the login window. Jump documents it and
   says to use an HDMI emulator [D]. The viewer says "no display" through the existing `displays: headless` status;
   the docs say "use a dummy plug".
7. **Sleep.** A Mac at the login window must stay online and awake. The daemon's sleep hold works with nobody
   logged in (`awake.rs:4-5`), but it depends on the keep-awake-on-mains change landing first. The display is woken
   per session (`platform/macos.rs:172`) [M in-session; U pre-login].
8. **Loading a pre-login agent with the login window already up** (install or self-update with nobody logged in).
   No documented command; RustDesk uses `launchctl load -w -S LoginWindow` [I]. The spike measures it. Otherwise
   the first log out or reboot after the update loads it, and the release notes say so.
9. **Root at the login window parses network input** (decision 4). Same class as SYSTEM on Windows. The spike's
   `spawnchild-as nobody` step tries an unprivileged child.
10. **A root process runs the app bundle's executable** at every login window.
    - If anything but root can write `/Applications/owlette.app`, that is a local root escalation.
    - The runner refuses to start unless its executable and the bundle above it are root's alone and not
      group/other-writable, the rule `install_is_protected` already applies to the sidecar
      (`swoop_spawn_posix.py:86-105`).
    - The security review (Task 3.2) owns it.
11. **Fast user switching.** With two sessions alive, the background user's app and streamer stay alive, and the
    streamer may capture a display that is off the console [I, RustDesk #13869]. The console-change watch kills the
    streamer whose context left the console.
12. **FileVault's default auto-login means the login window is the rarer case after a reboot** [I]. The feature
    mostly helps after a log out, with FileVault off, or after an ssh unlock that lands at the login window [U].
    On a FileVault rig the spike measures the cold-boot login window by setting `DisableFDEAutoLogin` for one boot,
    with the owner's ok, and reverting it.
13. **First login of a new account** brings up Setup Assistant and the owlette app's own Screen Recording ask in
    that account. That is today's behaviour, and nothing to do with this plan.

## Waves

Conventions: the swoop-macos standing rules apply (tasks.md). Tasks in one wave never touch the same file. Full text:
[tasks.md](tasks.md).

- **Wave 0, Spike S** (before any product code): 0.1 the probe · 0.2 rig facts · 0.3 the sitting · 0.4 memo and
  go/no-go
- **Wave 1, the parts** (after a go): 1.1 desktop headless login runner · 1.2 packaging · 1.3 agent console context
  and spawn routing · 1.4 streamer login-window context · 1.5 web reconnect and copy
- **Wave 2, wiring**: 2.1 manager console-change watch, capability and audit · 2.2 POSIX wiring test for the login
  path
- **Wave 3, proof**: 3.1 gate G on the product (owner sitting 2) · 3.2 security review of the new boundary
- **Wave 4, ship**: 4.1 docs, ADR amendment, glossary, PROTOCOL.md · 4.2 release and the upgrade-at-login-window check

## Gates

- **S** (Task 0.4): the go/no-go table above. The owner reads the memo before Wave 1.
- **G** (Task 3.1): on the signed product pkg, a real session through the login window.
  - Log out, see the login window, type the password from the viewer, be reconnected into the user's desktop.
  - Log out again and be reconnected to the login window.
  - Reboot, and the FileVault path as measured.
  - Latency recorded with n.
- **Release** (Task 4.2): the success criteria, each with an observed result.

## Success criteria

- A Mac on the release advertises `capabilities.swoop: 1` at the login window within one heartbeat of it appearing,
  on a measured macOS major with the grants in place, and `0` without them.
- From a Windows Chrome viewer, the login window is visible and controllable:
  - pick a user;
  - type the password;
  - sign in.
- The session moves to that user's desktop with one automatic reconnect, and no step-up is asked inside its 7 days.
- A log out moves a session the other way the same way.
- Every time a session moves, the record shows how long the reconnect took.
- No streamer outlives its context: no root streamer in a user's session, no user streamer for a user off the
  console.
- The bundle is never on disk. No `_owlette` member can reach the login-window queue or socket.
- No prompt is raised at the login window, ever.
- Windows and the in-session Mac path behave exactly as before. Their suites and the POSIX wiring test are green.
- Upgrading from 4.1.0 while the Mac sits at the login window leaves the login window reachable (or, if the spike
  says the agent loads only at the next login window, the release notes say so and the check proves that).

## Owner decisions and asks

**Answered 2026-11-25** ("yes to all", on the recommendations):
- 1 and 2: the plan and Spike S are approved, in one sitting at the Mac together with the 4.2.6 lock-screen check,
  after 4.2.6 is installed there. The owner runs the sudo steps.
- 3: apply now for the entitlement. The account holder applies.
- 5: login-window sessions follow the same switches as today; no separate opt-in.
- 6: macOS 26 only. The login-window capability stays off on every other major version until a Mac on it passes
  its own gate run; macOS 27 gets one when it ships.
- 7: FileVault is docs only.
- Still open: 4 (only if the spike shows input failing) and 8 (at Task 4.2).

1. **Approve the plan and Spike S.** That covers:
   - a probe app and two plists installed on the MBA with sudo;
   - the probe signed and notarized with the team's Developer ID;
   - a throwaway standard account `swoopspike` with a throwaway password, so no real password passes through the
     spike. Its removal afterwards is a delete of its home folder, shown to the owner as one exact command for an ok.
2. **One sitting at the Mac**, about 45-60 minutes (Task 0.3), plus the FileVault block if FileVault is on.
3. **Apply now for `com.apple.developer.persistent-content-capture`** (the account holder, at Apple's request form).
   - Recommended before the spike, because Apple's lead time is unknown and it is the fallback for four of the
     risks (2-5).
   - Using it means a Developer ID provisioning profile embedded in `owlette.app`, a build and signing change.
4. **A DTS code-level request for r. 5636091**, only if the spike shows input not reaching the login window.
5. **Policy**: login-window sessions under the same switches as today (recommended), or a separate site or machine
   opt-in.
6. **macOS 15 and 27 coverage**: a Mac on each for its own gate run, or the capability stays off on those majors.
7. **FileVault**: docs-only (recommended), not an owlette "restart and unlock" that handles a FileVault credential.
8. **Release version** at Task 4.2.

## Docs and ADR changes (Task 4.1)

- `web/content/docs/dashboard/swoop.mdx`:
  - `:25`: "someone logged in" becomes "the login window or a signed-in user (agent X.Y.Z, macOS 26)".
  - `:302`: replaced by a **the login window** paragraph: what works, how a sign-in reconnects, clipboard and audio
    off there, headless Macs, FileVault.
  - The grants table: whether the login window needs anything beyond today's grants, per the spike.
- `web/content/docs/agent/index.mdx:42`: the third launchd job.
- `web/content/docs/agent/installation.mdx:382-385`: the uninstall gains the new plist's unload and removal.
- `agent/swoop/PROTOCOL.md`:
  - §6 (`:372-387`): the login-window socket and `run --loginwindow`.
  - The `kill` reason `console_change` with its `context`, and `bye restart`'s `context`.
- `GLOSSARY.md`: **login window** (macOS) beside the Windows sign-in screen. _Avoid_: login screen for a Mac.
- `dev/completed/swoop-macos/plan.md` decision 9: a one-line pointer to this plan.
- `docs/changelog.md` and the README, if it states the limit (today it does not).

**Draft amendment to ADR 0009**, a new paragraph after the first and one consequence. The text is in the owner's
voice. It is not written into `docs/adr/` until the gate passes.

> On macOS the bar is met in two contexts, because launchd gives each its own process. The streamer cannot follow
> the console the way the Windows one follows the input desktop. In a signed-in session the desktop app starts the
> streamer as the console user, and that covers the lock screen. At the login window a pre-login launchd agent,
> which macOS runs as root, starts it under the same app identity and grants. A sign-in or sign-out therefore swaps
> the streamer, and the viewer reconnects in a few seconds rather than following a desktop switch. FileVault's
> unlock screen comes before macOS starts, so no owlette code runs there. A person unlocks it, at the Mac or, on
> Apple silicon with macOS 26, over ssh. macOS has no UAC. Its in-session authorization dialogs are covered as far
> as Apple delivers synthetic input to them. Login-window support is claimed per macOS major, because Apple has
> broken and fixed it across releases.
>
> Consequence: the login-window streamer is a root process that parses network input, the risk this ADR accepts
> for SYSTEM on Windows. Its bundle reaches it only through a root-only socket, and nothing in the `_owlette` group
> can reach that path.

## Sources

- **Apple**
  - TN2083 https://developer.apple.com/library/archive/technotes/tn2083/_index.html
  - PreLoginAgents https://developer.apple.com/library/archive/samplecode/PreLoginAgents/Listings/Read_Me_About_PreLoginAgents_txt.html
  - `launchctl(1)`, `fdesetup(8)`, `apple_ssh_and_filevault(7)` (keith.github.io/xcode-man-pages)
  - TN2150 https://developer.apple.com/library/archive/technotes/tn2150/_index.html
  - PPPC https://github.com/apple/device-management/blob/release/mdm/profiles/com.apple.TCC.configuration-profile-policy.yaml
  - the entitlement https://developer.apple.com/documentation/bundleresources/entitlements/com.apple.developer.persistent-content-capture
  - macOS 15 release notes
  - support.apple.com/en-us/124963
  - support.apple.com/guide/security/sec8447f5049
- **Apple DTS on the forums**: threads 814152 (fetched directly), 756908, 768146, 713396, 726470, 763453, 692749,
  682240, 800854, 730043.
- **Chrome Remote Desktop**: `remoting/host/curtain_mode_mac.cc` (fetched directly), `remoting/host/mac/host_service_main.cc`,
  `remoting/host/input_injector_mac.cc`, `remoting/host/installer/mac/LaunchAgents/org.chromium.chromoting.plist`.
- **RustDesk**: `src/platform/privileges_scripts/{daemon,agent}.plist`, `src/platform/macos.rs`,
  `libs/scrap/src/quartz/capturer.rs`, `libs/enigo/src/macos/macos_impl.rs`, issue #11802, discussions #13869 and #7762.
- **Vendors**
  - TeamViewer: knowledge-base "remote control a Mac"
  - AnyDesk: macOS changelog, "remote restart", "security permissions on macOS"
  - Splashtop: articles 115004192946, 115000983226, 29381364146459, 360042998132
  - Jump: docs.jumpdesktop.com connect/unattended-access, macos-permissions, black-screen
  - Parsec: article 32381618319124
  - Jeff Geerling on Tahoe FileVault over ssh

Quotes marked as coming from a summarising fetch are near-verbatim. Each one is rechecked where a task relies on it.
