# swoop at the macOS login window: tasks
**Progress**: 0/15 (draft; nothing starts before the owner approves plan.md)

Every task is executed by a fresh agent with no conversation context. Read [plan.md](plan.md) first, then only
the files your task names. Line numbers were read at `origin/dev` `22128da4` (4.2.5); re-locate by symbol if they
have drifted. `dev/active/` is gitignored, so add this directory with `git add -f` and keep a tracked copy.

**Standing rules for every task**
- The swoop-macos standing rules hold (`dev/completed/swoop-macos/tasks.md`, head):
  - Cargo runs from `agent/swoop`, never `--manifest-path`.
  - The Windows and macOS clippy and test commands are listed there.
  - Hardware tests are `#[ignore]`d, with their invocation in the module doc.
  - Never block the agent's 5-second loop.
  - Never raise a prompt without a click.
  - Never log a token, a key, a bundle, a password or clipboard content.
  - Never delete recursively or by glob.
- The Mac is the MacBook Air rig (`reference_mba_access`). Over ssh, wrap every command in `zsh -lc "…"`.
  - The signing keychain is locked in ssh sessions, so anything that signs or notarizes runs through the build
    LaunchAgent job (`dev/completed/swoop-macos/context.md:144-147`).
  - Anything that deletes a directory on the Mac (an app bundle, a user's home) goes to the owner as the exact
    command first.
- `agent/src/*.py` edits in a worktree reach this box's installed agent through the deploy hook. Make them with a
  script from the shell and say so in the log (CLAUDE.md, "Agent Dev Testing Workflow").
- Web: `npx eslint <file>` clean on every file you touch. UI copy is lowercase, icons are `lucide-react` only, and
  colours are theme tokens only. No new npm or pip packages. Do not edit the changelogs; leave one line in the Log.
- Labels: `[agent]` runs on this box or on the Mac over ssh. `[human]` needs the owner's clicks, password or eyes,
  and the task says exactly what the human does.
- Gates: **S** in Task 0.4 (the owner reads the memo before Wave 1), **G** in Task 3.1, release in Task 4.2.

## Wave 0: Spike S, before any product code

- [ ] **Task 0.1: the probe** `[agent]`
  - Files:
    - `agent/swoop/spikes/loginwindow-probe/` (create): `Cargo.toml`, `Cargo.lock`, `src/main.rs`, `Info.plist`,
      `bundle.sh`, `app.owlette.spike.lwprobe.plist`, `app.owlette.spike.lwselfcheck.plist`, `.gitignore`.
  - Do: build a spike-only app that answers plan.md's spike questions and nothing else.
  - **Crates and build.**
    - Use exactly the objc2 family versions `agent/swoop/Cargo.toml` already pins, plus `serde_json`. No crate
      the owner has not approved.
    - `bundle.sh` builds `owlette-lw-probe.app` with bundle id `app.owlette.spike.lwprobe`, and signs it with the
      team's Developer ID and the hardened runtime.
    - It notarizes and staples through the same notary profile `agent/build/macos/build.sh` uses. Ad-hoc
      signing proves nothing about TCC.
  - **The executable's modes.**
    - `watch` is what launchd runs:
      - Write one json report to `<dir>/<uid>/report-<pid>.json`, where `<dir>` is
        `/Users/Shared/owlette-lw-spike`. It sits outside the Owlette tree, so the throwaway account, which is not
        in `_owlette`, can write its own.
      - Then poll `<dir>/<uid>/cmd` every 500 ms, run the command it holds, then remove it. Log one json line per
        command to `<dir>/<uid>/log.ndjson`.
      - On SIGTERM, log the time, kill any child, and exit.
    - `report` prints the report to stdout, for a plain ssh check.
    - `child` is what `spawnchild` runs.
  - **The report fields.**
    - Identity: pid, ppid, uid, euid, the macOS version, and `SessionGetInfo`'s attributes.
    - The console: the `IOConsoleUsers` array as read in-process (darwin.py's read, `darwin.py:728-761`).
    - The three preflights: `CGPreflightScreenCaptureAccess`, `CGPreflightPostEventAccess`, `AXIsProcessTrusted`.
    - The display list: `SCShareableContent` (displays, or the error domain and code).
    - The cursor: `CGEventGetLocation`, and whether `NSCursor.currentSystem` answered.
    - Local Network: one UDP send to the subnet's broadcast, as `selfcheck` does.
  - **The commands.**
    - `shot`:
      - an `SCScreenshotManager` image of the main display, and one `CGDisplayStream` frame, as two PNGs;
      - a 5 s `SCStream` with its frame count;
      - each with its error if it failed.
    - `click <x> <y>` and `type <text>` post at `HIDEventTap` from a `HIDSystemState` source, as
      `agent/swoop/src/input/mac.rs:392,438` does.
      - `type` sends key down and key up per character through `CGEventKeyboardSetUnicodeString`.
    - `key <return|tab|escape>`.
    - `spawnchild`: posix_spawn this executable in `child` mode. The child writes its own report and a `shot`,
      which proves whether the parent's grants carry over at the login window.
    - `spawnchild-as <user>`: the same, but the child `setuid`s to `<user>` (`nobody`) before reporting. This is
      plan.md decision 4's unprivileged-child test.
  - **Logging rules.** The log never contains the text a `type` command carried. It records only the count of
    characters.
  - **The two plists.**
    - `lwprobe` runs `owlette-lw-probe.app/Contents/MacOS/owlette-lw-probe watch` with `LimitLoadToSessionType`
      `[LoginWindow, Aqua]`, `RunAtLoad`, and no `KeepAlive`.
    - `lwselfcheck` runs the **installed product's** `/Applications/owlette.app/Contents/MacOS/owlette-swoop
      selfcheck`, `LoginWindow` only, `RunAtLoad`, stdout to `<dir>/0/selfcheck-lw.json`. It is the control for
      the sidecar's own identity.
  - Done when:
    - The probe builds on the Mac.
    - `codesign --verify --strict --deep`, `spctl -a -t exec -vv` and `xcrun stapler validate` pass on the app.
    - `owlette-lw-probe report` from an ssh shell prints one json line.
    - `cargo clippy -- -D warnings` is clean in the spike directory.
  - Depends on: owner decision 1.

- [ ] **Task 0.2: rig facts and install** `[agent]`
  - Files: `dev/active/swoop-mac-login-window/spikes/S-login-window.md` (create).
  - Do: over ssh, record the "before" section of the memo:
    - `sw_vers`;
    - `fdesetup status`;
    - `sudo systemsetup -getremotelogin`;
    - `defaults read /Library/Preferences/com.apple.loginwindow`: `autoLoginUser`, `SHOWFULLNAME`,
      `DisableFDEAutoLogin`, whichever exist;
    - `pmset -g` and `pmset -g batt`, plus whether the rig is on mains;
    - `system_profiler SPDisplaysDataType`;
    - `ioreg -a -d1 -k IOConsoleUsers`, signed in;
    - the installed owlette version, and `ipc/tcc.json`;
    - whether fast user switching is on.
  - Then install (sudo):
    - the notarized probe app into `/Applications`, as root:wheel 755;
    - the two plists into `/Library/LaunchAgents`, as root:wheel 644.
  - Create the throwaway standard account: `sudo sysadminctl -addUser swoopspike -fullName "swoop spike" -password <random 12>`.
    - The password lives only in this session's scratch and in the `cmd` file at the moment it is typed.
  - Make the spike directory:
    - `<dir>` 0755 root:wheel;
    - one subdirectory per uid that will run the probe, each 0700 and owned by that uid: `0`, the owner's uid and
      swoopspike's uid.
    - The agent writes each `cmd` with sudo and reads every file with sudo.
  - Bootstrap only the Aqua instance now (`launchctl bootstrap gui/<owner uid> …`). The LoginWindow instance is
    loaded by launchd at the next login window, which is itself a measurement.
  - Done when:
    - The memo holds every value above.
    - `launchctl print gui/<uid>/app.owlette.spike.lwprobe` shows the probe running.
    - Its report is present, with the preflights false (no grant yet).
    - `swoopspike` shows in `dscl . -list /Users`.
  - Depends on: 0.1; owner decision 1.

- [ ] **Task 0.3: the sitting** `[agent+human]`
  - Files: the memo (0.2's).
  - Do: one sitting of about 45-60 minutes. The owner is at the Mac. This agent is on ssh and announces each
    command in chat before it runs.
    - The person never types into a terminal on the Mac.
    - The person types a real password only to unlock or sign in to their own account, at the Mac or in their own
      ssh prompt.
    - Every PNG is copied to this box and read by the agent before it states what it shows.
  - **Step 1, signed in, about 5 min.**
    - Human:
      - In System Settings → Privacy & Security → **Screen & System Audio Recording**: **+** → Applications →
        **owlette-lw-probe** → **Open**, and switch it on. Give your password if asked. If macOS offers to quit
        and reopen it, choose **Later**.
      - Then do the same in Privacy & Security → **Accessibility**.
      - Say "granted".
    - Agent:
      - `launchctl kickstart -k gui/<uid>/app.owlette.spike.lwprobe`, then read the report. Expect true
        preflights and a display list.
      - `shot`, the in-session control.
      - `spawnchild`.
  - **Step 1b, the macOS UAC equivalent, 1 min.**
    - Human: in System Settings → Users & Groups, click **Add User…** so the admin password sheet appears. Leave
      it, and touch nothing.
    - Agent:
      - `shot` (is the sheet in the picture?).
      - `click` on its password field.
      - `type zz`. Do the dots appear?
    - Human: say whether two dots appeared, then press **Cancel**.
  - **Step 2, the lock screen, 2 min.**
    - Human: press **control-command-Q** and do not touch the Mac.
    - Agent:
      - After 10 s, `shot`. Read the PNG: is it the lock screen, black, or only the wallpaper?
      - `click` on the password field.
      - `type zz`.
      - `key return`.
      - `shot`.
    - Human: say whether two dots appeared and whether it shook, then unlock with your own password.
  - **Step 3, log out to the login window, about 10 min.**
    - Human: Apple menu → **Log Out <you>** → **Log Out**. Then do not touch the Mac until told.
    - Agent, within 60 s:
      - Record when the uid-0 report appeared, against the log-out time.
      - Read `selfcheck-lw.json` (the product sidecar launched by launchd, with no grant of its own).
      - Read `ioreg -a -d1 -k IOConsoleUsers` at the login window.
      - `launchctl print` the job to find its domain.
      - `shot`. Read both PNGs: is the login UI (user tiles) visible, or only the wallpaper? Compare against the
        preflight values.
      - Record the 5 s `SCStream` frame rate.
      - `spawnchild`, and `spawnchild-as nobody`.
    - Agent, then input:
      - `click` on the **swoop spike** tile, at coordinates read from the PNG.
      - `shot`.
      - `click` on its password field.
      - `type <throwaway>`.
      - `key return`.
    - Agent, then the result:
      - Does `swoopspike` sign in (`who`, `ps` for its Finder)?
      - When did the LoginWindow instance log SIGTERM?
      - When did an Aqua instance start as swoopspike's uid?
      - Is any uid-0 child of the probe still alive afterwards (`ps -axo pid,ppid,uid,command`)?
    - Human:
      - Say what you saw at each command the agent announces.
      - If Setup Assistant opens for swoop spike, leave it.
      - If the owlette app asks swoop spike for Screen Recording, click **Deny**.
  - **Step 4, log out again, 3 min.**
    - Human: Apple menu → **Log Out swoop spike** → **Log Out**. Do not touch.
    - Agent:
      - Record whether, and when, the LoginWindow instance came back.
      - `shot`.
      - `click` the **swoop spike** tile. Wrong-password checks always go to the throwaway account, never the
        owner's.
      - `type zz`.
      - `key return`. Expect a shake.
    - Agent, while the login window is up, measure the load command for Task 1.2:
      - `sudo launchctl bootout` the job by the domain found in Step 3, and confirm the probe exits.
      - Then try `sudo launchctl load -w -S LoginWindow /Library/LaunchAgents/app.owlette.spike.lwprobe.plist`
        (RustDesk's form). Does an instance come up without a log out?
      - Record the exact commands that worked.
  - **Step 5, cold reboot, 3 min.**
    - Agent: say "rebooting now", then `sudo shutdown -r now`.
    - **FileVault off**:
      - Human: nothing.
      - Agent, once ssh answers:
        - Is the LoginWindow instance running after a cold boot (forum 682240)?
        - `shot`.
        - `click` the swoop spike tile, `type zz`, `key return`, `shot`.
      - Then go to Step 7.
    - **FileVault on**: go to Step 6.
  - **Step 6, FileVault (only if on), about 15 min.**
    - 6a, ssh unlock, if Remote Login is on:
      - Human: at this PC (not the Mac), open a terminal, run `ssh <your Mac user>@<Mac address>`, and type your
        own password at the prompt. The connection drops once the disk unlocks.
      - Agent, once the normal ssh answers: does the Mac land at the login window (a uid-0 report, IOConsoleUsers)
        or in your session (auto-login)? If at the login window, do the `shot` and `zz` check on the swoop spike
        tile.
      - If 6a does not unlock (Remote Login off, or no network at boot), the human types the password at the Mac
        instead, and the agent records where it lands.
    - 6b, the cold-boot login window on a FileVault Mac. With FileVault's default auto-login the Mac never shows a
      login window after a reboot, so the cold-boot case is otherwise unmeasured.
      - Agent: show the owner the exact command for an ok, then run
        `sudo defaults write /Library/Preferences/com.apple.loginwindow DisableFDEAutoLogin -bool YES`.
      - Agent: say "rebooting now", then `sudo shutdown -r now`.
      - Human: unlock at the Mac with your password. The login window should then appear. Do not sign in.
      - Agent: is the LoginWindow instance running after a cold boot? Then `shot`, and `click` the swoop spike tile,
        `type zz`, `key return`, `shot`.
      - Agent, then put it back: `sudo defaults delete /Library/Preferences/com.apple.loginwindow DisableFDEAutoLogin`,
        and record that it is gone.
    - 6c, optional, if time allows:
      - Human, signed in, at this PC: `ssh <your Mac user>@<Mac address>`, then `sudo fdesetup authrestart`, and
        type your password when asked.
      - Agent: record whether the Mac skips the unlock screen, and where it lands.
  - **Step 7, back to normal, 2 min.**
    - Human: sign in as yourself.
    - Optional, only if fast user switching is on:
      - Human: from the user menu in the menu bar, choose **swoop spike**. The agent reads you its throwaway
        password; type it.
      - Agent: does your session's probe keep running, and does it keep capturing while off the console? Record
        whether a pre-login instance ran in between.
      - Human: then switch back to yourself.
  - **Step 8, cleanup, 2 min.**
    - Human: switch the probe off in both Privacy panes.
    - Agent: show the owner, for an ok on each exact command:
      - the two `launchctl bootout`s;
      - `sudo rm` of the two plist files;
      - `sudo rm -r /Applications/owlette-lw-probe.app` and `sudo rm -r /Users/Shared/owlette-lw-spike`, each a
        recursive delete. Copy the PNGs and logs to this box first;
      - `sudo sysadminctl -deleteUser swoopspike` (deletes its home folder);
      - `sudo tccutil reset All app.owlette.spike.lwprobe`.
    - Agent: run only what the owner okays, and record what is left.
  - Done when the memo holds, per step:
    - the json lines and report;
    - every PNG's name and what it shows;
    - the person's words;
    - the timings: log out → uid-0 instance up, login → SIGTERM, SIGTERM → Aqua instance up, reboot → instance up;
    - the IOConsoleUsers dumps at each state;
    - the measured load and unload commands;
    - the FileVault landings;
    - what was cleaned up.
  - Depends on: 0.2.

- [ ] **Task 0.4: memo verdict, gate S** `[agent]`
  - Files: the memo; `dev/active/swoop-mac-login-window/plan.md` and `tasks.md` (copies of this draft, updated).
  - Do:
    - Fill plan.md's go/no-go table with the row that happened, citing the memo.
    - State:
      - which identity TCC credited at the login window: the probe's main executable, its child, and the product
        sidecar launched by launchd;
      - whether the preflights predicted the pixels (decision 9's report);
      - whether `nobody` kept capture and input (decision 4);
      - the IOConsoleUsers rule for "the login window is on the console" (Task 1.3);
      - the load and unload commands (Task 1.2);
      - whether a root child outlived the login (decision 6).
    - Rewrite every decision the spike contradicted, and argue the change in one line each.
    - If the row is "wait for Apple", write the DTS request text (the r. 5636091 and r. 121253782 references, the
      probe's exact calls, the macOS build, what was observed) for the owner to file, and stop.
  - Done when: the memo ends with **go**, **go, one extra step**, **go with a fallback** or **wait for Apple**, and
    the owner has read it.
  - Depends on: 0.3.

## Wave 1: the parts (after a go)

- [ ] **Task 1.1: desktop headless login runner** `[agent]`
  - Files:
    - `desktop/src-tauri/src/main.rs`
    - `desktop/src-tauri/src/lib.rs` (the `mod` line only)
    - `desktop/src-tauri/src/loginwindow.rs` (create)
    - `desktop/src-tauri/src/jobrunner.rs`
  - Do: `main()` checks for `--loginwindow` before anything Tauri runs. It is macOS only; elsewhere it exits 2 with
    one stderr line.
  - **Every refusal logs one line and exits 0.** The plist's `KeepAlive {SuccessfulExit: false}` would otherwise
    respawn it every 5 s at every login window.
  - **The mode refuses to start unless:**
    - `getuid() == 0`.
    - `current_exe()` and the three directories above it are root's, not links, and not group- or other-writable.
      That is the rule `install_is_protected` applies to the sidecar (`agent/src/swoop_spawn_posix.py:86-105`).
    - `ipc/loginwindow` exists as 0700 root:wheel.
  - **What it does:**
    - Writes `ipc/loginwindow/runner.pid` (0644 root).
    - Writes `ipc/loginwindow/state.json` (0644 root) at start and every 60 s, with what gate S chose: the
      preflights, or a one-frame check.
    - Polls `ipc/loginwindow/jobs` every 100 ms, and accepts only regular, root-owned files that are not group- or
      other-writable.
    - Serves only `launch`.
  - **Generalise `jobrunner::launch`.** Today the program directory and the socket uid are parameters
    (`jobrunner.rs:305`). Add the socket's directory, the stderr directory and the allowed args as parameters too:
    - The app's call stays byte-for-byte today's: `ipc/swoop`, `logs/swoop`, `LAUNCH_ARGS`.
    - The login runner passes `ipc/loginwindow`, `logs/swoop-lw`, and exactly `["run", "--loginwindow"]`.
    - It launches as the uid gate S chose: 0, or the role account if `spawnchild-as` kept capture and input.
    - The stderr directory must be root-only. A root writer in the group-writable `logs/swoop` is a
      hardlink-to-anywhere hole (review-2 noted this for the console user).
  - **On SIGTERM**: SIGTERM the child, SIGKILL it after 2 s, write its exit file, and exit 0. The child is in its own
    process group (`jobrunner.rs:433`), so launchd will not take it.
  - **Never** NSApplication, a window, the tray, `tcc::request*` or any `CGRequest*`.
  - Done when:
    - `cargo clippy --all-targets -- -D warnings` and `cargo test --locked` pass in `desktop/src-tauri` on this box
      and on the macOS and ubuntu legs.
    - Unit tests cover each refusal: not root, a writable bundle, a wrong directory mode, a non-root job, an arg not
      allowed, a socket in the wrong directory.
    - Unit tests cover the SIGTERM path killing a test child.
    - `npx tauri build --no-bundle` still succeeds here.
  - Depends on: gate S.

- [ ] **Task 1.2: packaging** `[agent]`
  - Files:
    - `agent/packaging/macos/app.owlette.loginwindow.plist` (create)
    - `agent/build/macos/build.sh`
    - `agent/packaging/macos/scripts/postinstall`
    - `agent/packaging/macos/scripts/preinstall`
  - Do:
    - **The plist.**
      - Label `app.owlette.loginwindow`.
      - `ProgramArguments`: `/Applications/owlette.app/Contents/MacOS/owlette-desktop --loginwindow`.
      - `LimitLoadToSessionType` `LoginWindow`, `RunAtLoad`, `KeepAlive` `{SuccessfulExit: false}`,
        `ThrottleInterval` 5.
      - A head comment in the house style says why it exists and that macOS runs it as root.
    - **`build.sh`** copies it beside the other two (`:127-128`).
    - **`postinstall`:**
      - `ipc/loginwindow` 0700 root:wheel and `logs/swoop-lw` 0750 root:wheel. `mode_dir` sets the `_owlette`
        group, so add a root-only variant rather than chmod-ing after it.
      - Load the agent with the command gate S measured, so a Mac updated at the login window gets the runner
        without a log out. If none worked, log that it loads at the next login window.
    - **`preinstall`:** unload it with the measured command before the payload lands. `pkill -x owlette-desktop`
      (`:39`) already stops the process; the job must be unloaded too.
  - Done when:
    - The signed build job ends `BUILD-EXIT=0`, and `pkgutil --expand` into a fresh directory shows the plist.
    - On the Mac: an install while signed in, then a log out, shows `owlette-desktop --loginwindow` as uid 0 and
      `runner.pid` and `state.json` present.
    - An install over ssh while the Mac sits at the login window gives the result gate S predicted.
  - Depends on: gate S.

- [ ] **Task 1.3: agent console context and spawn routing** `[agent]`
  - Files:
    - `agent/src/osadapter/darwin.py`, `agent/src/osadapter/posix.py`, `agent/src/osadapter/__init__.py`
    - `agent/src/swoop_spawn_posix.py`, `agent/src/swoop_spawn.py`
    - `agent/tests/unit/test_swoop_spawn_posix.py`, `agent/tests/unit/test_osadapter_contract.py`
  - Do:
    - **`console_context()`**: `('user', uid)`, `('loginwindow', None)` or `None`. It comes from the same in-process
      `IOConsoleUsers` read as `_console_session` (`darwin.py:728-761`), with the login-window rule gate S
      recorded. The rule is never the absence of a user alone: Setup Assistant and a machine with no window server
      are not the login window.
    - **`posix.run_job`** takes the queue and the liveness check. The default is today's: `ipc/jobs`, the app's
      pid file. The login runner's queue is `ipc/loginwindow/jobs`, and its liveness is `runner.pid`, root-owned
      and naming a live uid-0 `owlette-desktop`.
      - `_write_job` there writes 0600 root, with no group handover (`posix.py`'s `_write_job` gives files to the
        group today).
    - **`swoop_spawn_posix.spawn`** routes by context:
      - At the login window: a 0600 root socket in `ipc/loginwindow` (handed to the role account if gate S chose one).
      - The peer uid is the uid the runner launches as.
      - `_pin` checks that uid, an `exe()` equal to the verified sidecar path, and a parent equal to the runner's pid.
      - The job's args are `["run", "--loginwindow"]`.
      - The user path is unchanged.
      - A missing runner is `REFUSAL_DESKTOP_NOT_RUNNING`, so the web's retry stays as it is
        (`machineFailure.ts:11-15`).
  - Done when:
    - `agent/.venv/Scripts/python -m pytest agent/tests/` is green here, with the POSIX tests as skips.
    - The new tests pass on the macos-15 and ubuntu legs, covering:
      - each context from recorded IOConsoleUsers fixtures, taken from gate S's dumps;
      - routing;
      - the login socket's mode and directory;
      - a wrong-uid peer, a wrong-exe pin and a wrong-parent pin, each refused.
    - `grep -n "log" agent/src/swoop_spawn_posix.py` shows nothing that carries a bundle.
  - Depends on: gate S.

- [ ] **Task 1.4: streamer login-window context** `[agent]`
  - Files:
    - `agent/swoop/src/main.rs`, `agent/swoop/src/platform/macos.rs`, `agent/swoop/src/clipboard/mac.rs`,
      `agent/swoop/src/audio/sck.rs`
    - `agent/swoop/src/ipc.rs`, `agent/swoop/src/session/mod.rs`
    - `agent/swoop/testdata/protocol/pipe/pipe-stdin-control.ndjson`, `agent/swoop/testdata/protocol/index.json`
  - Do:
    - **Where it runs.** `run --loginwindow` (macOS only) is the login-window context. It is never inferred from the
      uid, since gate S may have chosen a role account.
    - **What is off.** The clipboard feature and audio stay off, each with one log line.
    - **The cursor.** It follows gate S's `NSCursor.currentSystem` answer, falling back to in-frame with
      `cpos.visible = false` (swoop-macos decision 7's rule).
    - **The kill.**
      - The `kill` control line accepts `reason: "console_change"` with a required `context` of `loginwindow` or
        `user`, naming what the console switched **to**. It byes every viewer `restart`, as `service_stop` does,
        carrying that `context`.
      - No other `bye` carries `context`.
      - Add the golden vector and its index entry.
  - Done when:
    - The Windows and macOS command sets in the standing rules pass, and the golden vectors pass.
    - `git diff` shows no change in what Windows emits.
    - A unit test proves `--loginwindow` disables both features, and that a `console_change` without a valid
      `context` is refused with a log line and changes nothing.
  - Depends on: gate S.

- [ ] **Task 1.5: web reconnect and copy** `[agent]`
  - Files:
    - the viewer's `bye` handling and the session bar in `web/lib/swoop/` and `web/components/swoop/`. Find them
      with `grep -rn "'restart'"`; the task's log names the files before editing.
    - their tests under `web/__tests__/`
    - `web/e2e/specs/swoop/mac-login-window.spec.ts` (create)
  - Do:
    - A `bye` `restart` carrying `context` starts the next session at once, not on the growing delay, and does not
      count toward the "at most twice in ten minutes" picture-stall rule.
    - The bar says **switching to the login window** or **switching to the signed-in desktop** until the picture
      returns. That copy is lowercase.
    - There is no other login-window label: the picture shows it, and the streamer's `status` reaches the agent,
      not the page.
    - A `restart` without `context` is today's behaviour.
  - Done when: `npx eslint` is clean on every touched file, and `npx tsc --noEmit`, `npm test` and `npm run e2e`
    (`/preflight`) pass with the new spec.
  - Depends on: gate S (for the field names in 1.4, written from plan.md).

## Wave 2: wiring

- [ ] **Task 2.1: console-change watch, capability, audit** `[agent]`
  - Files:
    - `agent/src/swoop_manager.py`, `agent/src/swoop_capability.py`
    - `agent/src/osadapter/darwin.py` (the capability read only)
    - `agent/tests/unit/test_swoop_manager.py`, `agent/tests/unit/test_swoop_capability.py`
    - `web/app/api/agent/swoop/events/route.ts` and its test (the agent's `session_started` event, `:57`)
  - Do:
    - **The watch.** While a streamer runs, read `console_context()` once a second on the manager's own thread,
      never the 5-second loop. When the context the streamer was spawned for leaves the console, send
      `{"type":"kill","reason":"console_change","context":<what is now on the console>}`.
    - **Booking.** Book it as its own end reason, outside the spawn-rate ceiling.
    - **A new ensure during a switch** waits up to 20 s on the worker for the target runner (the app's pid file, or
      `runner.pid`), then refuses as today.
    - **Capability at the login window** is the login runner's `state.json`:
      - root-owned and not group- or other-writable;
      - fresh within `TCC_STATE_MAX_AGE_SECONDS`;
      - true per gate S's rule;
      - on a macOS major in `LOGIN_WINDOW_MAJORS`, a constant whose comment names the gate that measured each major
        and what would add one.
    - **The audit.** The agent's `session_started` event carries `context`. The server's own start row is written
      before the machine answers (`sessions/route.ts:340-359`), so it cannot carry it.
  - Done when:
    - The agent suite is green here and on the POSIX legs, with tests for:
      - the kill on each transition: login, log out, fast user switch off and on;
      - the ceiling not charged;
      - the bounded wait;
      - each refusal of a bad `state.json`;
      - the major gate.
    - The web route's test accepts `context` and refuses any other value.
  - Depends on: 1.3, 1.4.

- [ ] **Task 2.2: POSIX wiring test, login path** `[agent]`
  - Files: `agent/tests/integration/test_swoop_wiring_posix.py`, `agent/tests/integration/fake_runner.py`.
  - Do:
    - Add a fake login runner on the root-only queue, with the uid it trusts injected, as `jobrunner.rs` tests do.
    - Drive the real `SwoopManager` through:
      - a spawn at the login window;
      - a console change to a user, giving `console_change` with the `restart` bye in the fake streamer's output;
      - a spawn through the fake app.
    - Name every replaced piece in the module doc, as the existing test does.
  - Done when: it is green on the macos-15 and ubuntu-24.04 legs, and skipped on Windows with its reason.
  - Depends on: 2.1.

## Wave 3: proof

- [ ] **Task 3.1: gate G, on the product** `[agent+human]`
  - Files: `dev/active/swoop-mac-login-window/spikes/G-product.md` (create).
  - Do:
    - Build the signed pkg from the branch through the build job and install it on the Mac over ssh.
    - Confirm all three launchd jobs and `state.json`.
  - **The owner's sitting.** About 30 min, from this PC's Chrome. The Mac only needs to be awake on mains.
    1. Open the Mac in swoop while signed in. A session works as today.
    2. In the viewer: Apple menu → **Log Out** → **Log Out**.
       - Agent: records the time to the **switching to the login window** line, and to the picture.
    3. In the viewer, click your tile and type your password. The viewer sends it like any other key; nothing logs
       it.
       - Agent: records the switch back to your desktop and its time. No step-up is asked.
    4. Lock from the special keys menu, then unlock from the viewer.
    5. Agent: reboots the Mac (`sudo shutdown -r now`, announced). Then the FileVault path as gate S found it. The
       owner unlocks if it asks.
       - Agent: records how long until swoop reaches whatever the Mac shows.
  - **Agent, alongside:**
    - Run the overlay latency measurement the macOS GA used, at the login window, n ≥ 30.
    - Confirm after each switch that no streamer runs in the wrong context (`ps -axo pid,ppid,uid,command`).
    - Confirm no bundle on disk (`ipc/loginwindow` holds only `runner.pid`, `state.json` and, briefly, a socket).
  - Go: every step works and the times are recorded. Anything else is written up and stops Wave 4.
  - Done when: the memo holds each step's result and times, the latency with n, and the word go or no-go; the owner
    has read it.
  - Depends on: 1.1, 1.2, 2.1, 2.2, 1.5.

- [ ] **Task 3.2: security review of the new boundary** `[agent]` (an Opus adversarial review, read-only)
  - Files: `dev/active/swoop-mac-login-window/research/review-security.md` (create).
  - Do: review the branch's diff under CLAUDE.md's review discipline, with actor, mechanism and outcome for anything
    above low. Cover:
    - the root runner's start conditions;
    - every path root writes (stderr, exit file, pid, state) against symlink and hardlink plants;
    - the queue and socket modes;
    - the pin;
    - whether any `_owlette` member or the console user can reach the login path;
    - the capability report's trust;
    - the console-change kill identity;
    - the audit;
    - a hostile network peer reaching a root streamer (what it can touch beyond today's console-user streamer).
  - Done when: each finding is fixed on the branch or accepted in writing by the owner.
  - Depends on: 1.1, 1.2, 1.3, 2.1.

## Wave 4: ship

- [ ] **Task 4.1: docs, ADR, glossary, protocol** `[agent]`
  - Files:
    - `web/content/docs/dashboard/swoop.mdx`
    - `web/content/docs/agent/index.mdx`
    - `web/content/docs/agent/installation.mdx`
    - `agent/swoop/PROTOCOL.md`
    - `GLOSSARY.md`
    - `docs/adr/0009-swoop-is-our-own-webrtc-streamer.md`
    - `dev/completed/swoop-macos/plan.md`
  - Do: carry out plan.md's "Docs and ADR changes". The ADR amendment uses the draft text, corrected to what gates S
    and G proved. Every claim cites what measured it.
  - Done when:
    - The docs build.
    - `grep -n "someone must be logged in" web/content` finds nothing.
    - The owner has read the ADR text before it is committed.
  - Depends on: 3.1, 3.2.

- [ ] **Task 4.2: release** `[agent+human]`
  - Files: per the build-system skill.
  - Do:
    - Follow the release recipe in order: version and changelog first, every installer built, uploaded to dev and
      downloads verified before any push.
    - Then the upgrade path: on the Mac, at the login window, upgrade from 4.1.0 (the oldest Mac release). A
      downgrade first needs the owner's ok.
    - Confirm the login window is reachable as gate S predicted for an update with nobody logged in.
  - Done when: every success criterion in plan.md carries an observed result.
  - Depends on: 4.1.

## Log
