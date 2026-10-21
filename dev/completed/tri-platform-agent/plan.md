# tri-platform agent — plan (RECONSTRUCTED 2026-09-17)

**Created**: 2026-09-13 or earlier [inferred: decision 12 cites an "owner requirement 2026-09-13"] | **Status at loss (2026-09-16 23:12)**: Waves 0–3 committed; the Linux lane (3b) merged into the feature branch; macOS 3.2 landed on the Mac branch; Wave 4 (desktop app) in progress in two uncommitted lane worktrees | **Reconstructed from**: see `README.md`. Tags: `[verbatim]` / `[inferred]` / `[unknown]`.

## Goal

Run the owlette agent (the Python daemon) and the owlette desktop app (Tauri) on **macOS and Linux as well as Windows**, with one codebase, every Windows behaviour unchanged, and the dashboard able to tell the three apart. [inferred: C:6ef1b057 "Waves 0-3 of dev/active/tri-platform-agent (macOS + Linux agents alongside Windows)"; H §13]

Owner requirement: "anything that runs the OS runs owlette, down to a Raspberry Pi and up to a video server" [verbatim: H §13 decision 12]. For macOS it was narrowed on 2026-09-16 to Apple silicon only, with macOS 15.0 as the floor [verbatim: H §16.3].

## Scope

- **In** [inferred: H §§12–15, commit history]:
  - `agent/src/osadapter/` (the OS seam), identity and key migration, the hoot tool split, per-platform cortex CLI pins, and roost destinations per OS.
  - POSIX service wiring (self-update, reboot/shutdown), POSIX pairing (preseed and the privileged-request seam), and the POSIX GUI job seam.
  - The desktop app on three OSes (Wave 4).
  - Packaging: macOS `.pkg` (5.1), Linux `.deb` (5.2), and the release workflow (5.3).
  - The dashboard's `osFamily`/`capabilities.*` surface (6.x), install docs (6.4), and swoop's macOS/Linux streamer backends (Wave 8, per decision 23).
- **Out / deferred** [verbatim: H §13 decisions 1, 12, and C2]:
  - `agent/host` is never ported (decision 1).
  - rpm is a non-goal.
  - Linux Wayland/PipeWire capture is v1.1; v1 is X11 only.
  - Windows on ARM runs the x64 build under emulation.
  - Windows signing stays unfunded (decision 17).
- **Size**: 56 tasks. The Progress counter read 16/56 after Waves 0–3 and 20/56 after the Linux lane [verbatim: T#2, T#80]. It was probably not updated for the Mac's 3.2 or for Wave 4 before the loss [unknown].

## Architecture (as built, 2026-09-16)

- **`osadapter` seam** [verbatim: H §4; code on origin]:
  - A 19-operation `typing.Protocol`: `data_root, console_user, session_env, spawn_as_user, run_job, capture_screen, launch_managed_process, stable_machine_id, key_material, service_control, pending_reboot, reboot, shutdown, cancel_reboot, installed_software, notify, desktop_process_name, json_lock, streamer_capable`.
  - `_ARMS = {'win32': 'win', 'linux': 'linux', 'darwin': 'darwin'}`, resolved lazily through `find_spec`; PEP 562 `__getattr__` lets call sites spell `osadapter.reboot(30)`.
  - `posix.py` is the shared POSIX half: `linux.py` and `darwin.py` each re-export 9 of its operations and answer 10 themselves.
  - `darwin.py` also needs four `sys.platform == 'darwin'` arms inside private `posix.py` helpers: `_graphical_session`, `_session_display_environ`, `_spawn` and `_xauthority` [verbatim: H §16.2].
- **Data root** [verbatim: H §4, §12; W4:4.5]: `%PROGRAMDATA%\Owlette` on Windows, `/Library/Application Support/Owlette` on macOS, `/var/lib/owlette` on Linux. `OWLETTE_DATA_ROOT` overrides it. Decision 4 has the mode table.
- **Install root** [verbatim: H §15 Task 3.4; on-disk `paths.rs` in w4a]: `/opt/owlette` on Linux, `/Library/Application Support/Owlette/runtime` on macOS.
- **JSON lock** [verbatim: H §8 item 9]: `shared_utils._CrossProcessLock` owns it on every OS: the named mutex `Global\OwletteJsonFileMutex` on Windows and `flock(2)` on `<data_root>/tmp/json.lock` (0660) on POSIX. `json_lock()` returns it. The Rust writer takes the same identity (Task 4.3).
- **GUI job seam** (POSIX only, decision 5):
  - The daemon writes `ipc/jobs/<id>.json` (0640 root:group). The resident desktop app runs it and answers in `ipc/results/<id>/result.json` [verbatim: W4:4.5 prompt].
  - Job types are `capture`, `shell`, `notify` and `launch`; the typed error is `desktop_not_running` [verbatim: H §12].
  - A capture job is `{type:'capture', monitor, timeout_s}`, and its result carries `files:[…]` plus an integer `monitors`. A notify job is `{type:'notify', title, body}`. The daemon waits 120 s [verbatim: H §9].
- **Privileged-request seam** (POSIX only, decision 4 round-3 audit, Task 3.7) [verbatim: H §7]:
  - The console user writes `ipc/requests/<id>.json` at 0600 or 0640, with an explicit `fchmod` before the rename, quoting the one-shot nonce from root-owned 0640 `ipc/request_nonce`.
  - Verbs are `pair`, `restart` and `reboot`, with no `leave`. The answer goes to `<id>.result` as JSON lines. `restart` and `reboot` are limited to one per five minutes. The audit log is `logs/privileged_requests.log` at 0600.
  - Off Windows, `tmp/restart.flag` is honoured only when root owns it [verbatim: T#62].
- **TCC seam** (macOS) [verbatim: H §16.2]: `ipc/tcc.json` = `{"screen_recording": bool, "checked_at": <unix s>}`, owned by the console user, with no group or world write bit, at most 300 s old.
- **Root writes** [verbatim: H §3]: every root write under the data root goes through `shared_utils.open_new_file()` (`O_WRONLY|O_CREAT|O_EXCL|O_NOFOLLOW` at 0600, `fchmod`/`fchown` on the descriptor, then `os.replace`).
- **Seat rules** [verbatim: H §6]:
  - A login window is not a seat, and neither is a session in teardown.
  - A launch refused for want of a seat spends no relaunch budget.
  - The armed reboot gate sits above the seat check.
  - The seat is read once per tick, on the loop thread only.
- **Identity** [verbatim: H §13 decision 8, H §16.2]: persisted `<data_root>/config/machine_id`, read through `shared_utils.get_machine_id()`. Key material comes from `MachineGuid` on Windows, `/etc/machine-id` on Linux, and `IOPlatformUUID` on macOS (read in-process, no fallback), with no hostname term.
- **Supervision** [verbatim: H §13 decisions 1–2, §12]: launchd on macOS and systemd on Linux; the init system starts the desktop app on POSIX. Labels are `app.owlette.agent`, `app.owlette.desktop` and `app.owlette.update`; units are `owlette-agent.service` and `owlette-desktop.service`. The POSIX groups are `_owlette` (macOS) and `owlette` (Linux).

## Decisions

Numbering is the plan's own. Decisions 1–8, 12, 17, 22 and 23 below are **[verbatim: H §13]**, copied byte for byte from the handoff, which copied them from the original `plan.md`. Line-number citations inside them are anchored at `a49ed4cc` [verbatim: H §15 preamble]. Where the Mac or a later ruling amended a decision, the amendment follows under "Amendments". Gaps are marked, not filled.

1. **`agent/host` is not ported and never compiled for POSIX. Zero Rust changes to that crate.** launchd/systemd
   own supervision; `registration.rs` (508 lines) is pure SCM/NSSM migration with no analogue; `supervisor.rs`
   stop-grace/kill-wait become one directive each. `agent/host/src/paths.rs:56` already runs `owlette_runner.py`,
   so the POSIX `ExecStart` target exists today. *Rejected:* `#[cfg(windows)]`-gating the SCM code — taxes five
   files, adds a cargo leg per OS, forces a `+crt-static` decision on a release profile frozen by the
   Defender-ML false positive (`agent/host/Cargo.toml:40-58`), and collides with the no-workspace rule at
   `Cargo.toml:19-21`.

2. **On POSIX the init system starts the desktop app; the daemon never launches it.** Retires, for POSIX, the
   whole token ladder (`_enable_privileges` `:2576-2625`, `_get_token_from_user_process` `:2626-2707`,
   `_refresh_user_token` `:2708-2776`, `_get_elevated_install_token` `:2777-2828`, `launch_desktop_app_as_user`
   `:2885-2934`, `display_manager._clone_user_token_from_explorer` `:1539-1594`) with zero replacement code.
   `tmp/tray.pid` keeps the same location, format and write-then-rename semantics on all three; the liveness check's image-name guard (`shared_utils.DESKTOP_EXE_NAME`, compared at `shared_utils.py:924` and `owlette_service.py:2135`) becomes a per-OS value (`owlette-desktop.exe` / `owlette-desktop`) through a 16th adapter operation, `desktop_process_name()`. *Fallback if spike 0.4 fails:* daemon spawns the app
   through the decision-4 console-user path, +15 lines.

3. **The adapter is `agent/src/osadapter/` — never `agent/src/platform/`.** `agent/tests/conftest.py:14` and
   `owlette_runner.py:17` put `agent/src` at `sys.path[0]`, and `mcp_tools.py:14`, `shared_utils.py:8`,
   `secure_storage.py:63`, `configure_site.py:725` import stdlib `platform`; a package named `platform` shadows
   it and does not build. Surface: 19 operations (including `json_lock()`, `desktop_process_name()`, `shutdown(delay)`, `cancel_reboot()` and `streamer_capable()`),
   ~1,020 lines across five files.
   Anything capability-gated gets **no adapter row**. *Rejected:* the 26-row `PlatformAdapter` table from the
   inventories — two thirds of its rows return "unsupported" on two of three platforms.

4. **Managed process launch stays in the daemon on all three OSes.** `launch_process_as_user`
   (`owlette_service.py:3034-3263`) is untouched on Windows: the installer path needs
   `_get_elevated_install_token` (LocalSystem only), app-owned supervision is orphaned when the app dies, and
   2,252 lines of tests (`test_kill_safety`, `test_inherit`, `test_launch_failed`, `test_process_lifecycle`)
   pin its failure semantics. POSIX arm ~90 lines in `osadapter`: resolve the console user, build the session
   env, spawn as that user and never as root. macOS uses root-invoked `launchctl asuser <uid>` wrapping
   `sudo -u <user>` — `asuser` adopts the session's bootstrap namespace only, it does **not** drop privileges.
   Linux spawns via `subprocess.Popen(argv, user=uid, group=gid, extra_groups=<the kiosk user's supplementary gids>, start_new_session=True, env=session_env)` — no `preexec_fn`, which CPython documents as unsafe in a threaded process, and this daemon runs a thread pool plus a dozen threads — with the session env lifted from the
   graphical session leader's `/proc/<pid>/environ` (`DISPLAY`, `XAUTHORITY`, `XDG_RUNTIME_DIR`,
   `DBUS_SESSION_BUS_ADDRESS`, `XDG_SESSION_TYPE`, `HOME`/`USER`/`LOGNAME`) and never a hardcoded cookie path
   — GDM, LightDM and SDDM differ, and `DISPLAY` without `XAUTHORITY` gives root "cannot open display". A
   managed macOS `exe_path` ending in `.app` resolves to `Contents/MacOS/<CFBundleExecutable>` (stdlib
   `plistlib`) before spawn; `open -a` is never used for a managed process — LaunchServices reparents it to
   launchd and leaves no supervisable pid. On Linux the managed child inherits the daemon unit's mount
   namespace and `NoNewPrivileges`; a kiosk app that needs a setuid helper is out of scope, documented.
   Supervision stays psutil PID-based. **POSIX data-root modes** (applied by `postinstall`/`postinst`,
   mirrored in Tasks 5.1/5.2): data root 0750 root:`_owlette`/`owlette` — the dedicated group owns the root
   so the kiosk user gets group traversal (wheel/root would leave other=--- and block even `stat` on `ipc/`),
   and the root stays non-group-writable so `.tokens.enc` (0600 root) cannot be replaced; `config/`, `tmp/`,
   `ipc/` 0770 root:<group>; `logs/`, `cache/` 0750 root:<group>; `config/config.json` and `tmp/json.lock`
   0660 root:<group>, the lock pre-created at install rather than by whichever process wins. The desktop app
   runs as the kiosk user and is a first-class writer of `config.json`, `app_states.json`, `restart.flag`,
   `gui.pid` and `tray.pid`. `ipc/cortex_*` is a kiosk-user→root channel by design (hoot runs as the console
   user), so those directories stay group-accessible; the drain is gated on `is_cortex_enabled()` so with
   hoot off the group-writable queue cannot command the daemon. Round-2 audit additions: `ipc/swoop/` is 0770 root:<group> with its files 0640 root:<group> — the runner is the kiosk-user app and must read then unlink the bundle. `.tokens.enc` 0600 root is daemon-created (Task 3.3, `os.open(…, O_NOFOLLOW, 0o600)` + `chmod`), not part of the install-time table: launchd and systemd run the daemon at umask 022, so a bare `open()` would leave it 0644 inside the group-traversable root. The four privileged app actions — pair, leave, restart, reboot — are requests the app drops into the 0770 `ipc/` seam for the daemon to execute (the `ipc/cortex_*` pattern), never an elevation prompt on a kiosk that has no admin user; on Linux `systemctl start|stop` from the tray is allowed by a shipped polkit rule scoped to `owlette-agent.service` and group `owlette`. A managed macOS `.app` is launched with a disclaiming `posix_spawn` (`responsibility_spawnattrs_setdisclaim`, ~40 lines in `darwin.py`) so the customer's app owns its own TCC grants instead of inheriting owlette's; `launchctl asuser <uid> open -a` is the documented fallback for apps that must be supervised by bundle-id lookup. The reboot/shutdown subsystem (`shutdown /r|/s|/a` + `wevtutil`, four call sites) is re-pointed onto `reboot(delay)` / `shutdown(delay)` / `cancel_reboot()` with real countdowns on POSIX. Sleep and display blanking are disabled at install time (`pmset -a sleep 0 displaysleep 0 disksleep 0`; `systemctl mask sleep.target suspend.target hybrid-sleep.target` + the GNOME power setting), the POSIX equivalent of `configure_power_plan`. Round-3 audit additions: an `ipc/` request from the app is honoured only when the file is owned by the uid `console_user()` resolves, carries no group or world write bit, and holds the one-shot nonce the daemon last wrote to a root-owned 0640 `ipc/request_nonce`; anything else is unlinked and logged; `leave` is not a seam verb at all (deregistration is an uninstall-time root operation or a dashboard command), and `restart`/`reboot` are rate-limited to one per five minutes with an audit row each — the same group-writable directory whose cortex queue is gated. macOS payload layout: `/Library/Application Support/Owlette/runtime/{python,agent/src,VERSION,uninstall.sh}`, root:wheel 0755, outside any admin-writable directory; the LaunchDaemon's `ProgramArguments` point there, and `/Applications/owlette.app` holds only the GUI and the TCC-bound streamer — deleting the bundle degrades GUI jobs to `desktop_not_running` and never stops the daemon. Desktop-unit enablement is scoped to the kiosk user (a symlink in that user's `~/.config/systemd/user/graphical-session.target.wants/`, `systemctl --global enable` only when the user cannot be resolved) and the unit carries `ConditionGroup=owlette`, because `--global` also starts it in the GDM greeter's session manager. Tray service control on Linux calls `systemctl` directly as the kiosk user — the D-Bus action `org.freedesktop.systemd1.manage-units` is what the shipped polkit rule allows; `pkexec` checks a different action and would prompt — and on macOS it drops a `restart` request into the seam; there is no `osascript … with administrator privileges` anywhere. `logs/swoop/` is 0770 root:<group>, the one log directory a kiosk-user process writes.

5. **On POSIX, GUI jobs (capture, notify, shell-in-session, launch) execute in the resident Tauri app
   (`desktop/src-tauri/src/jobrunner.rs`, `#[cfg(unix)]`). On Windows nothing changes.** On Sequoia+ a
   LaunchDaemon cannot capture at all, TCC Screen Recording attaches to a signed **bundle**, MDM cannot
   pre-grant, and `persistent-content-capture` is a restricted entitlement — so the only place a macOS capture
   can legally happen is inside `owlette-desktop.app`. Jobs fail **closed** with a typed `desktop_not_running`
   error the dashboard renders as copy, never a 20 s hang. *Rejected:* moving **Windows** capture into the app
   — a Windows machine with the desktop app killed would lose `capture_screenshot` (public API, hoot tool,
   talons `visual_check`, CLI, crash path). *Rejected as settled:* shelling `/usr/sbin/screencapture` from the
   app — TCC responsibility for a spawned CLI child is not automatically the calling bundle; that is spike 0.2's
   go/no-go, with an in-process ScreenCaptureKit binding (+250, one crate, owner question 5) as the fallback.
   **This is also the swoop spawn path on POSIX** — see `context.md` → cross-plan decision C2 for the three
   conditions a child must meet to inherit the bundle's TCC grant.

6. **Two gating fields, one vocabulary: `osFamily` for static OS facts, the existing `capabilities.*` map for
   per-machine grants.** Heartbeat gains `osFamily` (`windows`|`macos`|`linux`), `osVersion`, `arch`
   (`x64`|`arm64`) computed **once at startup** through the normalisation table in `context.md` C3, plus
   integer `capabilities.screenCapture`, `capabilities.packageInstall`, `capabilities.temps` next to the
   shipping `capabilities.displayRemoteApply: 1` (`firebase_client.py:1538`). Named `osFamily`, not `platform`
   — `authorizedPlatformHandler` / `PlatformHandlerContext` own that word across 7+ routes. *Rejected:*
   `osFamily`-only gating (cannot express "this mac has not granted screen recording"); a new
   `platformFeatures` matrix (a third vocabulary).

7. **TCC / portal grant state is a product surface.** `desktop/src-tauri/src/tcc.rs` probes screen recording,
   accessibility and portal availability, renders a first-run banner with a one-click deep link to the right
   settings pane, and publishes the result into the seam so the daemon flips `capabilities.screenCapture`
   within one heartbeat. The dashboard shows "screen recording not granted" instead of a black frame.

8. **Machine identity and Fernet key derivation are fixed together, with a re-encrypt migration.**
   `secure_storage.py:63-70` keys on `f"{machine_id}:{hostname}:owlette-agent"` with `hostname = platform.node()`,
   and `machine_id = socket.gethostname()` is the Firestore doc id at seven call sites (`shared_utils.py:121-122`,
   `firebase_client.py:152`, `auth_manager.py:139`, `owlette_cortex.py:506`, `owlette_service.py:1727,1793,2495-2496`,
   `configure_site.py:553`). A macOS `Name.local` is DHCP-mutable: a rename both forks the document **and**
   bricks `.tokens.enc`. Fix in one task: persist `config/machine_id` seeded from the current hostname on
   upgrade (no live Windows doc re-keys), read through a new `shared_utils.get_machine_id()` at every call
   site; derive key material from `IOPlatformUUID` / `/etc/machine-id` / `MachineGuid` with no hostname term;
   ship a first-run re-encrypt that reads under the old derivation, rewrites under the new, leaves the
   original intact on failure and keeps a v1 copy for one minor.

9. **[decision 9: not recovered]** [unknown]

10. **[decision 10: not recovered]** [unknown]

11. **[decision 11: text not recovered]** [inferred: T#62, T#77] Software deployment (install/uninstall) is Windows-only: tool/feature definitions carry `os: ['windows']`, so `_terminate_processes_for_install`'s basename matcher is "unreachable off Windows by decision 11". Cited by the Wave 4 prompts as one of the four decisions every Wave 4 task reads ("plan.md decisions 2, 4, 6 and 11") [verbatim: W4:4.5]. Note: `c2415865` later gave macOS an application-bundle uninstall arm per owner ruling Q-M1 [verbatim: C:c2415865] — whether that amends decision 11 was not recorded [unknown].

12. **Runs wherever the OS runs (owner requirement 2026-09-13): one build per architecture per OS, any GPU.**
    Windows x64 (Windows on ARM runs it under x64 emulation, documented, not a native build); macOS **universal2**
    (arm64 + x86_64 in one `.pkg` — `lipo`'d Tauri app, two python-build-standalone payloads, `hostArchitectures`
    lists both); Linux `.deb` for **x86_64 and arm64** (Ubuntu 24.04 and Raspberry Pi OS Bookworm, which is
    Debian-based, so the same package and maintainer scripts apply). Capture on Linux is X11 in v1: a Wayland
    session publishes `capabilities.screenCapture: 0` with the documented switch (Pi OS Bookworm defaults to
    Wayland; `raspi-config` → X11 is the one-line fix), and PipeWire/portal capture is the v1.1 item. No GPU
    requirement anywhere: hardware encoders are used where present and every OS has a software floor (swoop
    decision 12). *Superseded:* the earlier "macOS arm64 only, Linux x86_64 only" scoping (~700 lines and ~3 weeks
    saved) — the owner's requirement is that anything that runs the OS runs owlette, down to a Raspberry Pi and up
    to a video server. rpm stays a non-goal (`.deb` covers Debian, Ubuntu and Pi OS).

13. **[decision 13: not recovered]** [unknown]

14. **[decision 14: not recovered]** [unknown]

15. **[decision 15: not recovered]** [unknown]

16. **[decision 16: not recovered]** [unknown]

17. **Notarize in its own job that hands a stapled artifact to the digest job.** `build-installer.yml:21-25`
    forbids signing after the SLSA digest; `:58` caps the job at 30 min; `notarytool` is asynchronous. Three
    build jobs (each signing/notarizing/stapling) → one digest+release job looping the existing
    `"<hex>␣␣<filename>"` construction over n subjects. Every Mach-O in the macOS payload is signed inside-out
    (bundled interpreter, every `.so`) with `com.apple.security.cs.disable-library-validation`. Windows stays
    unsigned (`build-installer.yml:17`) until the Azure Artifact Signing work is funded.

18. **[decision 18: not recovered]** [unknown]

19. **[decision 19: not recovered]** [unknown]

20. **[decision 20: not recovered]** [unknown]

21. **[decision 21: text not recovered]** [inferred: H §15 Task 4.1] Keeps `tauri-plugin-fs` in the desktop crate ("**Do not** remove `tauri-plugin-fs` (decision 21)"). Its rationale is unknown.

22. **Pairing is ported, with a preseed for bulk deploy.** `configure_site.py` (1,057 lines) is the add-a-machine
    entry point and is Windows-shaped in four places plus the hostname-minted doc id; it routes through
    `osadapter`, and the `/ADD=<phrase> /SILENT` bulk-deploy analogue is a preseed file read by
    `postinstall`/`postinst` (Task 3.7).

23. **swoop's macOS/Linux streamer backends are this plan's Wave 8** (+2,825 firm, up to 3,825 — low
    confidence, the only wave in either plan whose adds no spike measures; swoop prices one Windows backend at
    ~2,400). They depend on the job runner, on bundle signing (same Team ID, in-bundle path, `posix_spawn`
    ancestry — `com.apple.security.inherit` is an App Sandbox key, not a TCC lever, and the attribution is
    undocumented behaviour spike 0.2 measures) and on the packaging built here; the swoop plan's Wave 9 leaves
    the `#[cfg]` seams for them.

Decisions numbered above 23: [unknown] — no surviving reference.

### Amendments recorded after the decisions were written

- **Decision 4 (macOS spawn), amended from the Mac 2026-09-16** [verbatim: H §16.2]: `launchctl asuser <uid> sudo -u <user>` is replaced by a launchd job in `gui/<uid>` (temp plist in a root 0700 dir, `bootstrap`, `kickstart -p`, bounded wait past the `xpcproxy` trampoline, a label `app.owlette.session.<uuid>` per spawn, exited jobs booted out first, one spawn at a time, 10 s budget, `AbandonProcessGroup`). The disclaiming `posix_spawn` is dropped. Fallback if root checks refuse it: `launchctl asuser` under a root `posix_spawn` with `responsibility_spawnattrs_setdisclaim` plus an `initgroups`/`setgid`/`setuid`/`execv` shim — never `sudo` or `su`.
- **Decision 4 (macOS seat)** [verbatim: H §16.2]: `IOConsoleUsers` read in-process via IOKit replaces `stat -f%Su /dev/console`; a seat is the session with `kCGSSessionOnConsoleKey` and `kCGSessionLoginDoneKey` true and a real account (not uid 0, `root`, `loginwindow`, or an underscore account).
- **Decision 8 (macOS identity)** [verbatim: H §16.2]: `IOPlatformUUID` in-process; no fallback (a stand-in key empties `.tokens.enc`).
- **Decision 12 for macOS, owner ruling 2026-09-16** [verbatim: H §16.3]: Apple silicon only; floor macOS 15.0; `distribution.xml` `hostArchitectures="arm64"`, one python-build-standalone payload, Tauri `--target aarch64-apple-darwin`. Supersedes the universal2 sentences in decision 12 and Tasks 4.6/5.1. The wire ids `latest_macos_universal` / `cortex_cli_macos_universal` now name arm64 artifacts; renaming is the orchestrator's call [verbatim: H §16.3].
- **Decision 2 / Q24 (startx kiosks)** [verbatim: T#269]: "startx-from-tty kiosks stay unsupported until logind (or an equally root-owned signal) can name the seat"; `console_user()` gets no desktop-app fallback; Task 6.4 documents it.
- **Decision 4 (audit log mode)** [verbatim: H §8 item 15]: `logs/privileged_requests.log` is 0600, not 0640 (tightened in `21ad3fea`).
- **Decision 5 / C2 (macOS capture evidence, research only)** [verbatim: H §16.3]: `/usr/sbin/screencapture` carries `com.apple.private.tcc.check-allow-on-responsible-process`, which supports decision 5's shell path; a daemon must never capture.
- **Cross-plan rule C2 (the POSIX bundle), amended 2026-09-28** [recorded 2026-09-30 from `dev/active/swoop-macos/plan.md` decision 2]: on POSIX the bundle rides a unix socket the daemon listens on (`<data_root>/ipc/swoop/<id>.sock`), not a `stdin_path` file. The socket is the streamer's stdin and stdout, so the `token` refresh and `kill` control lines keep flowing and the bundle never touches disk. The runner's path rule applies to the socket. `desktop_not_running` is a spawn refusal in the agent's log, not an `endReason`.

## Cross-plan rules C2 and C3 [verbatim: H §14, copied from the plan's `context.md`]

**C2 — swoop's spawn path per OS.** Windows: the service spawns `owlette-swoop.exe` via `CreateProcessAsUser`
with the session bundle on stdin (swoop decision 3). macOS: the daemon writes a `launch` job and the resident
desktop app spawns the streamer as its **child**, which inherits the bundle's TCC Screen Recording /
Accessibility responsibility **only if** the streamer binary lives inside `owlette.app/Contents/MacOS/`, is
signed with the same Team ID and the app's hardened-runtime entitlements, and is spawned by the app via
`posix_spawn` — never launchd / `launchctl asuser`, which would make the child its own responsible process
and prompt again. `com.apple.security.inherit` is an App Sandbox key, not a TCC lever; the attribution is
undocumented behaviour, and spike 0.2 measures whether it holds. Linux: the app spawns the child
with the X11 session env from 3.1; v1 is X11-only per spike 0.3 (a Wayland path would pass the PipeWire
remote fd over the job seam — not exercised in v1). On POSIX the session bundle travels in the root-owned
0770 `ipc/jobs` directory (group `_owlette` on macOS, `owlette` on Linux — never `staff`, never a
users-modify path). If the desktop app is not running the job times out with `desktop_not_running` and
swoop's session store records it as `endReason`. On POSIX the `launch` job in the 0770 `ipc/jobs` directory carries no secret — only argv and a `stdin_path` pointing at a `0640 root:<group>` file in `<data_root>/ipc/swoop/` (0770 root:<group>, so the kiosk-user runner can read it and unlink it after EOF); group `_owlette`/`owlette`, never `staff` (Task 4.3). The runner accepts a `stdin_path` only when it resolves inside `<data_root>/ipc/swoop/`, `st_uid == 0` and `st_mode & 0o022 == 0`.

**C3 — `osFamily`/`arch` heartbeat fields.** Whichever task lands first writes them (swoop 2.2 or this plan's
6.1); the other adds only what is missing (`osVersion`, `capabilities.screenCapture|packageInstall|temps`).
Normalisation is fixed here so neither task can get it wrong: `osFamily = {'win32':'windows',
'darwin':'macos','linux':'linux'}[sys.platform]`; `arch = {'AMD64':'x64','x86_64':'x64','arm64':'arm64','aarch64':'arm64'}[platform.machine()]`,
unknown → the raw string, logged once; a table-driven unit test pins all six mappings. **Absent is Windows:**
every reader resolves a missing or unrecognised `osFamily` to `'windows'` (`machine.osFamily ?? 'windows'`) —
the whole pre-3.4 fleet has no such field and keeps every affordance it has today; only a machine that
positively declares `macos` or `linux` loses one. Capability keys are written as **separate dotted paths**
(`capabilities.swoop`, `capabilities.screenCapture`) — `_upload_metrics` uses `update()` with dot notation,
and a whole-map `capabilities: {...}` write silently drops `displayRemoteApply`
(`firebase_client.py:1525-1526`, `:1538`). There is no disk-IO capability key: per-volume disk IO is
presence-derived. `capabilities.swoop` is `1` iff the streamer binary is present **and** `osadapter.streamer_capable()` (Windows: true; Linux: X11 session; macOS: Screen Recording granted), recomputed on the same tick as `capabilities.screenCapture`.


## Wire names [verbatim: H §12]

### Wire names (chosen once, lowercase)

| kind | name |
|---|---|
| machine doc fields | `osFamily` (`windows`\|`macos`\|`linux`), `osVersion`, `arch` (`x64`\|`arm64`) |
| capability keys | `capabilities.screenCapture`, `capabilities.packageInstall`, `capabilities.temps` (+ existing `displayRemoteApply`; swoop adds `capabilities.swoop`) — always written as separate dotted keys |
| TS type / helper | `MachineOsFamily`, `web/lib/machineOs.ts` → `supports()`, `osLabel()`, `pathHint()`, `shellName()` |
| python package | `agent/src/osadapter/` (`__init__`, `win`, `posix`, `darwin`, `linux`) |
| data-root override | `OWLETTE_DATA_ROOT` (retires the competing `PROGRAMDATA` / `XDG_DATA_HOME` test overrides) |
| persisted identity | `<data_root>/config/machine_id`, read via `shared_utils.get_machine_id()` |
| pairing preseed | `<data_root>/config/pairing.json` (or `OWLETTE_ADD=<phrase>`) |
| job seam job types | `capture`, `shell`, `notify`, `launch`; error code `desktop_not_running` |
| JSON lock | `<data_root>/tmp/json.lock` (`flock`) on POSIX; the named mutex stays on Windows |
| installer metadata doc ids | `latest_windows_x64`, `latest_macos_universal`, `latest_linux_x64`, `latest_linux_arm64` |
| cortex cli pin doc ids | `cortex_cli_windows_x64`, `cortex_cli_macos_universal`, `cortex_cli_linux_x64` |
| installer route param | `?platform=windows_x64` (default) |
| launchd / systemd ids | `app.owlette.agent`, `app.owlette.desktop`, `app.owlette.update`; `owlette-agent.service`, `owlette-desktop.service` |
| POSIX groups | `_owlette` (macOS), `owlette` (Linux) |
| tool definition fields | `os?: OsFamily[]`, `osNotes?` |
| pytest marker | `@pytest.mark.windows` |
| Apple CI secrets (eight) | `APPLE_CERT_P12_BASE64`, `APPLE_CERT_PASSWORD`, `APPLE_INSTALLER_CERT_P12_BASE64`, `APPLE_INSTALLER_CERT_PASSWORD`, `APPLE_TEAM_ID`, `APPLE_API_KEY_ID`, `APPLE_API_ISSUER_ID`, `APPLE_API_KEY_BASE64` |

## Execution model [verbatim: T#2, T#77, T#284]

- The owner's instruction: "dispatch opus subagents as needed for tasks. do not run hundreds; only run what you need, but ensure adaquete code reviews (adversarial) to ensure optimal code quality and DRY/KISS. follow the plan, and flag any deviations from it in the task md, with an explanation of why" [verbatim: T#2].
- Each task runs as one opus implementer, then two read-only adversarial reviewers (correctness and conformance), then a fixer, then a second correctness review and fixer (at most two rounds). Each wave closes with a three-lens review (integration, conformance, guardrails), a fixer and a re-review [verbatim: T#2, T#77]. Structured outputs are IMPL, REVIEW and FIX [verbatim: T#284].
- Deviations go into `tasks.md` as dated `**Status YYYY-MM-DD:**` and `**Addendum YYYY-MM-DD (…):**` lines inside each task block. Each wave gets a newest-first entry in `## Log`, and owner questions go into `decisions.md` [verbatim: T#77, T#80].
- Hard rules for every agent [verbatim: W4:4.5]:
  - Files under `agent/src/**.py` are edited only through the Bash tool with a CRLF-preserving script. The PostToolUse deploy hook mirrors Edit/Write changes into the live `C:\ProgramData\Owlette` install and restarts the production service.
  - No `git commit/add/stash/checkout/reset/clean` from agents, and no npm/pip installs.
  - The plan folder is read-only for everyone except the bookkeeper agent.

## Lanes, worktrees and branches

| worktree (at `C:\Users\admin\Documents\Git\`) | branch / base | used for | state at 2026-09-17 |
|---|---|---|---|
| `Owlette` (main checkout) | `dev` | held the gitignored plan folder only; untouched by agents [verbatim: T#2] | destroyed; `.git` gone [verbatim: I] |
| `Owlette-wt-tri` | `feat/tri-platform-agent` | Waves 0–3; the merge of #167; the crash-alert and handoff-refresh lanes; the os-identity feature [verbatim: T#2, T#284, T#312] | partly deleted. Every surviving file is byte-identical to `f56487b8` apart from `desktop/src-tauri/Cargo.lock` (a local change that predates Wave 4) and `gen/schemas` [verbatim: I] |
| `Owlette-wt-tri-l3b` | detached at `62686311` | the Wave 3b lane (3.1→3.2→3.4→3.7), later ported into `-linux` [verbatim: T#2, T#77] | intact, git broken. Superseded: it lacks the close-review and VM-round fixes (`open_new_file`, `_LIVE_SESSION_STATES`, the `needs_os_arm` gate) that are in `dd7b5106` [inferred: D] |
| `Owlette-wt-tri-linux` | `feat/tri-platform-linux` | port target for 3b, the close review, the VM fix rounds, and the VM scripts [verbatim: T#62, T#166] | intact, git broken, 100% identical to `dd7b5106` [verbatim: I] |
| `Owlette-wt-tri-w4a` | detached at `4a3de0cd` | Wave 4 lane A: 4.1, then 4.3 [inferred: D, T#340] | intact, git broken, **uncommitted work** |
| `Owlette-wt-tri-w4b` | detached at `4a3de0cd` | Wave 4 lane B: 4.1 ported, 4.2, then 4.5 and 4.7 queued [verbatim: W4:4.2r2, W4:4.5, W4:4.7] | intact, git broken, **uncommitted work** |

Branch strategy [verbatim: H §1, H1 §1]:

- `dev` is the integration branch and auto-deploys; never commit to `dev` or `main`.
- `feat/tri-platform-agent` carries Waves 0–3 through PR **#150**, which is still **open** against `dev` (checked 2026-09-17).
- `feat/tri-platform-linux` was cut from it for the Linux lane and merged back into `feat/tri-platform-agent` as PR **#167** (`47e5cae0`, 2026-09-16 17:03). It is closed.
- `feat/tri-platform-macos` is cut from `feat/tri-platform-agent` (base `4a3de0cd`) and worked on the MacBook Air. Its PR against `dev` opens only after #150 merges, rebasing first. No macOS PR exists yet (checked 2026-09-17).
- Wave 4 lanes are detached worktrees with no branch; their work was to be ported into `feat/tri-platform-agent` [inferred: the pattern of Wave 3b, T#2].

File ownership once the Linux lane merged [verbatim: H §1]:

- The Mac owns `osadapter/darwin.py`, `agent/packaging/macos/**`, `agent/build/macos/**`, `desktop/src-tauri/src/{capture,tcc}.rs`, the macOS arms of `service_ctl.rs`/`process_ctl.rs`/`startup_link.rs`/`shell_open.rs`, `PermissionBanner.tsx`, the macOS log and the macOS spike results.
- One writer at a time: `.github/workflows/agent-tests.yml`, `desktop/src-tauri/src/lib.rs`, `desktop/src-tauri/Cargo.toml`.

## Lab [verbatim: T#2, T#102, W4:4.5; lab.md itself is lost]

- **Windows box**: the orchestrator's machine. The Windows pytest gate ran from a scratchpad venv (`venv311`).
- **WSL2 Ubuntu 24.04**, run as root: the Linux CI-leg stand-in and the Tauri Linux toolchain (`/root/owlette-desktop-probe`). It has no graphical seat. **Its disk was lost** in the incident [verbatim: the task brief for this reconstruction].
- **Hyper-V VM `owlette-kiosk`**: Ubuntu 24.04.5, GDM autologin as `kiosk` (uid 1000, group `owlette`), Xorg `:0`. It is reached over ssh with the key under `C:\VMs\owlette-kiosk\ssh\`, and has a golden checkpoint `golden-20260916`. The agent is at `/opt/owlette/{venv,agent/src}`, paired to **dev** as machine `owlette-kiosk` (site `default_site`, "TEC"), and runs under `owlette-agent.service` (renamed from the lab unit `owlette-agent-lab` for Wave 4) [verbatim: T#323, T#342, W4:4.2r2]. `C:\VMs` survived [verbatim: I].
- **MacBook Air**: Apple silicon, macOS 26.6 (25G72), uv CPython 3.11.14, rustup 1.98.1 [verbatim: HL].
