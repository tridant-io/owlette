# tri-platform agent — macOS work log

Append one dated entry per work session: what landed (task ids), deviations with reasons, what was verified on the real machine vs. unit-tested only, open questions. Commit it with the code.

### 2026-09-15
- Handoff written (`tri-platform-macos.md`). Nothing started on the Mac yet.

### 2026-09-16
- Handoff refreshed by the Windows-side orchestrator, not by the Mac. Still nothing started on the Mac.
- **What changed under it:** the Linux lane (Tasks 3.1, 3.2, 3.4, 3.7) merged into `feat/tri-platform-agent` as PR #167 at `47e5cae0`. `osadapter/posix.py`, `osadapter/linux.py`, the POSIX service wiring and the pairing seam are all on the base now; `feat/tri-platform-linux` is closed and there is no second platform branch left to coordinate with.
- **CI state at that commit:** `macos-15` **1351 passed / 278 skipped** (16.0 s), `ubuntu-24.04` 1491/138, `windows-latest` 1585/201; four `--ignore` entries per POSIX leg, all permanent, and the import-smoke step gating on all three.
- **`tri-platform-macos.md` rewritten sections 1-11**, with four new sections — what `darwin.py` must provide (every row `linux.py` overrides plus the Linux-shaped shared-arm hooks), the seat rules to honour identically, what is already solved, and the corrections list in §8. Sections 12-15 (wire names, decisions, C2/C3, the verbatim task blocks) are byte-identical to the first version apart from their heading numbers.
- **Measured for this refresh, not quoted:** the no-arm conftest gate skips **69** tests on a Mac today — 52 in `test_configure_site_headless.py`, 9 in `test_screenshot_capture.py`, 5 in `test_posix_loop_duties.py`, 2 in `test_service_shutdown.py`, 1 in `test_osadapter_contract.py` — and all 69 start running the day `darwin.py` lands. Counted by collecting the suite with a read-only plugin that reads each item's `needs_os_arm` marker and `os_arm` fixture closure, excluding what `@pytest.mark.windows` skips anyway.
- **Open for the Mac agent, carried forward:** owner Q4/Q5/Q6/Q12/Q15/Q16 are still pending; Q24 is ruled (startx-from-tty is not a seat, `console_user()` gets no `tmp/tray.pid` fallback); Q23's refusal-reporting assumption stands unchanged.
- **Same-day correction pass, after a close review of the refresh against the merged code.** Five defects in `tri-platform-macos.md`, all now fixed in §§1-9 and recorded in §8 items 12-15:
  - §5's re-export list called all nine `linux.py` shared rows "unchanged" on darwin. Four are not — `console_user`, `session_env`, `spawn_as_user`, `launch_managed_process` — and because `posix.launch_managed_process` (`posix.py:316,333`) and `posix.spawn_as_user` (`:204`) resolve `console_user`/`session_env`/`_spawn` at `posix` module scope, a `darwin.py` override never reaches them. Corrected to five genuinely-neutral re-exports plus a table of the three `posix.py` private helpers (`_graphical_session`, `_session_display_environ`, `_spawn`) that each need a `sys.platform == 'darwin'` arm, and §1's "do not rewrite `posix.py`" rule amended to sanction exactly that. Built to the old list, `darwin.py` would have shipped a Mac where `console_user()` is always None, `_seat_absent()` is permanently True and every managed launch, hoot spawn and privileged request is refused while the machine reports healthy.
  - `cancel_reboot()`'s prescribed mechanism — SIGTERM to `Popen(['shutdown', ...]).pid`, that pid doubling as the "is one scheduled" record — targets a process that has already exited: BSD `shutdown(8)` forks and the parent prints `shutdown: [pid N]` and returns. The row now says to measure it on the Mac first, take the pid from `shutdown`'s own output, persist it under the data root so the record survives a daemon restart, and confirm it still names a `shutdown` process before signalling. Carried forward from the plan's Task 3.4 "Do", so the plan text is stale on this too (§8 item 13).
  - `pending_reboot()` was presented as macOS work to write. `tools_posix.check_pending_reboot` (`tools_posix.py:366`) already ships the darwin arm and `linux.py:160-165` is a platform-agnostic three-line delegation, not "the one marker reader" — `darwin.pending_reboot()` is the same three lines. Added to §7. The row (and §4) also spelled the command `softwareupdate -l`; the shipped arm passes `--list --no-scan`, and without `--no-scan` the call reaches Apple's servers on every invocation.
  - "The rest of the 278 are `@pytest.mark.windows`" understated `TestDarwin`'s brief by 71 tests. Measured by collecting the suite with a read-only marker-counting plugin: 69 gate + 125 `@pytest.mark.windows` + **71** `linux_only` (`test_osadapter_contract.py:38`, reason `a Linux mechanism; macOS answers it in darwin.py` — `TestLinux` plus the `@linux_only` members of `TestPosix`) + 13 other `skipif` = 278, cross-checked against ubuntu's 138 = 125 + 13. §2 now carries the split, and notes that the *passed* counts move with anything landing after `47e5cae0` while the four skip counts are the tripwire.
  - §7 gave the privileged-request audit log as 0640 root:root. It is 0600 (`configure_site.REQUEST_AUDIT_MODE`), tightened from 0640 by the 3.1 close review in `21ad3fea`; the plan's Task 3.7 status line still says 0640 and is stale. A Mac agent verifying the mode table against the promise would have filed a false mismatch, or re-opened the kiosk-readable-audit hole by "correcting" the code back.
- **Verified for this pass:** every file:line citation above read out of the tree at `47e5cae0`; the 71/125 marker counts collected on Windows with the same read-only plugin; `agent/tests/` green on Windows (1585 passed, 204 skipped — three more skips than the CI row because the crash-alert lane's new `posix_only` tests are in the working tree, and those three *run* on a Mac). Nothing in this pass touched code.

### 2026-09-16 — the Mac (macOS 26.6, 25G72, Apple Silicon)
- **First run of the handoff on the Mac.** Base `4a3de0cd` (two past `47e5cae0`), branch `feat/tri-platform-macos`, uv CPython 3.11.14.
- **§2/§9 checks, measured:** the CI invocation without `-x` gave 1352 passed / **2 failed** / 278 skipped. The skip split was exactly §2's: 69 gate (52/9/5/2/1), 71 `linux_only`, 138 = 125 + 13. The import smoke passed. Both failures are macOS 26 only (§16.1 item 3). A skeleton `darwin.py` retired the gate with **no** failures, so §9 step 5's failure-set-as-task-list was empty (§8 item 17).
- **What landed**, oldest first:
  - `6f0a71eb`: a private executable for tests (copied `/bin/sleep` is killed by an AMFI launch constraint).
  - `99aa37ef`: `shared_utils.resolve_exec_target()` for `.app` bundles at six call sites.
  - `9d6473a2`: the macOS `check_pending_reboot` rewrite.
  - `57802bce`: the run-once self-update job.
  - `4b7618e5`: `osadapter/darwin.py`, the four `posix.py` darwin arms and `TestDarwin`.
  - `f9fb62c7`: the no-arm conftest gate retired in one commit (nine markers, four fixtures, the workflow comment), suite green.
- **Deviations from the task text, each with its reason:** all in §16.2.
  - The launchd GUI-domain job replaces `asuser … sudo -u` and the disclaiming spawn.
  - `IOConsoleUsers` replaces `stat /dev/console`.
  - In-process `IOPlatformUUID` with no fallback.
  - A fourth `posix.py` arm (`_xauthority`).
  - The bundle-walk inventory with empty publisher and uninstall command.
  - A scan-based `cancel_reboot()` with no persisted pid.
  - The `ipc/tcc.json` seam contract.
  - Seven `loginctl`-stubbed `TestPosix` seat tests (eight items) marked `linux_only`, with macOS equivalents added.
- **Verified on this Mac, non-root:**
  - Every `darwin.py` row against real macOS: IOKit `IOPlatformUUID` equals `ioreg`'s; `IOConsoleUsers` shape and cost; 79 bundles in 51 ms; `launchctl` exit codes (113 unknown, 3 for bootout of an unloaded label).
  - The GUI-domain spawn end-to-end in the user's own domain: pid, uid, ppid 1, cwd, env with per-user `TMPDIR`, own responsible process, no relaunch throttle, plist removable after bootstrap, sweep of exited jobs.
  - `launchctl submit` keepalive: `runs = 2` after an exit 0.
  - `softwareupdate --list --no-scan` at 26.4 s cold and not listing the prepared 26.6.2.
  - The new pending check reporting that prepared update in 12 ms.
- **Suite on this Mac after these changes:** 1527 passed / 216 skipped, with `linux_only` 78.
- **Unit-tested only:** `service_control`, `reboot`/`shutdown`/`cancel_reboot`, and the self-update job all need root. The `ubuntu-24.04` and `windows-latest` legs could not be run here (no Docker, and pushing a feature branch runs no workflow). Tracing the tool tests through the Windows leg by hand found one break before it was pushed (`read_plist` needed `getattr` for `O_NOFOLLOW`/`O_NONBLOCK`/`O_BINARY`), folded into `9d6473a2`; a read-only review traced the rest through both legs (next bullet).
- **Unverifiable on this rig:** §16.4, in order. The spawn and seat checks come first because everything that launches depends on them.
- **Design review of the spawn and seat, before these were pushed.** The review confirmed the launchd GUI-domain job over `asuser` plus a disclaiming spawn, and `IOConsoleUsers` with the landed filter. It also rejected a uid ≥ 501 rule, because `nobody` is −2 and hidden admin accounts have low uids. Four Low findings were fixed and folded into `4b7618e5`:
  - A lock now holds one spawn's sweep, bootstrap and kickstart together, so a concurrent spawn's sweep cannot boot out a job bootstrapped but not yet kickstarted.
  - A 10 s budget covers the whole spawn, so a stalled launchd cannot hold the monitor loop for 30 s per call.
  - A pid gone before it became its program is a failed launch, not a crash; that is Linux's Popen parity.
  - `AbandonProcessGroup` keeps an app's leftover children its own business, as on Windows and Linux.
  The review also found three defects in the brief's first draft of the spawn, and the committed code already avoided all of them:
  - an `exe == argv[0]` settle check that never settles for scripts or symlinked interpreters, hoot's included;
  - labels hashed from argv, so identical entries boot each other out;
  - a bootout-then-bootstrap race on one label.
  One Medium finding stays open and unmeasurable here: whether a logging-out session is still listed on the console after its apps die. That is §16.4 item 2.
- **CI-leg review, before push.** Reasoned through `ubuntu-24.04` and `windows-latest`, simulating Windows paths with `ntpath`: **clean on both.** `macos-15` showed no concrete failure. On its advice three macOS risks were closed and folded in:
  - The exited-job sweep now matches our own label pattern with a whitespace-tolerant regex rather than counting tab-separated fields.
  - The private-executable fixture checks `xcode-select -p` before invoking `cc`, which on a Mac without developer tools is a stub that opens their installer, and it skips on an unaccepted Xcode licence.
  - The live GUI-domain spawn test fails rather than skips under `GITHUB_ACTIONS`, since it is the only test that reaches launchd for real.
  One suggestion is noted, not done: most `TestDarwin` parsing tests are pure logic and could also run on the Linux leg with the platform forced, as `TestApplicationBundles` does.
- **Rejected, do not re-raise:** §16.5.
- **Open questions:** Q-M1 (macOS uninstall), Q-M2 (15.0 floor, x86_64), Q-M3 (MDM recommendations), all in §16.6. Q4/Q5/Q6/Q12/Q15/Q16 are unchanged.
- **Research inputs:** four read-only research agents covered Apple's `system_cmds` shutdown source, spawning into a console session, macOS 15/26 platform changes, and the local signals for a pending restart. Two review agents covered the spawn and seat design and cross-platform CI breakage. Every claim they made that code depends on was re-measured on this Mac before use.
- **Side effect to know about:** a research agent ran `sfltool dumpbtm` without root. It waits on authd, so an admin password dialog may have appeared briefly on this Mac before the command was killed after about 10 s.
- **Owner rulings, same day:**
  - **macOS is Apple silicon only** (Q-M2's first half). Universal2 is superseded for the Mac, and §16.3 carries the arm64 packaging.
  - **Rust is on this Mac:** rustup stable 1.98.1, `aarch64-apple-darwin`.
  - **Q-M1 (uninstall):** the recommendation, removing the bundle as root after closing its processes, is recorded in §16.6 and awaits confirmation.
  - **Q-M3 (MDM docs):** still open.
- **Task 4.1 baseline, measured:** `cargo check` in `desktop/src-tauri` on this Mac stops inside the dependency graph, as §2 predicted. `windows-future` 0.3.2, pulled in by the unconditional `windows` dependency, fails with 16 errors before any of owlette-desktop's own code compiles. How many errors the crate's own Windows-only modules add is unknown until 4.1 moves `windows`/`windows-service` under `[target.'cfg(windows)'.dependencies]`.
- **More owner rulings, same day:**
  - **macOS 15.0 is the floor**, recorded in §16.3.
  - **Q-M1 uninstall:** the owner deferred to the recommendation, so an app is quit and its bundle removed as root.
  - **Q-M3:** decided on the Mac as an optional MDM section in Task 6.4's docs.
- **`c2415865` feat(agent-macos): uninstall an application bundle.** Built by a delegated agent to the spec in §16.6 Q-M1, then checked here: suite 1542 passed / 216 skipped.
  - Inventory rows now carry the bundle path as `uninstall_command`. The dashboard refuses an uninstall for a row without one (`web/lib/actions/triggerUninstall.server.ts:230`). No web change was made.
  - The handler's darwin branch runs before the `registry_utils` (winreg) import and accepts only `installer_type == 'app'`.
  - **The security boundary:** it removes only a bundle `installed_software()` lists at that moment.
  - It gracefully terminates every process running from inside the bundle and refuses if one survives.
  - Removal walks the folders above the bundle with `O_NOFOLLOW` and runs `rmtree(dir_fd=…)`, so a parent swapped for a link cannot redirect it. `shutil.rmtree.avoids_symlink_attacks` is True on 3.11.
  - A permission failure names macOS's App Management protection as a possible cause. **Unverified:** whether a root LaunchDaemon may delete another developer's bundle without an App Management grant needs root on hardware; it is added to the §16.4 checks.
- **Found in passing, not in the macOS lane — for the orchestrator:**
  - **Deployment uninstalls fail on every OS today.** `/api/sites/{siteId}/deployments/{id}/uninstall` queues only `installer_name` and `deployment_id`, so the agent answers "Software name and uninstall command required". The machine route also ignores the `deployment_id` that `useUninstall` sends.
  - **The Linux branch of the same handler still dies** on `import registry_utils`, which imports `winreg`.
  - **`TestPosix::test_a_capture_the_app_refuses_leaves_nothing_behind` failed once in 16 full-suite runs** and passed 40 times alone. The likely cause is a race in `_FakeJobRunner`, which can pick a job up again before `run_job` withdraws it. It is untouched here, and with `-x` it can redden a CI leg.
