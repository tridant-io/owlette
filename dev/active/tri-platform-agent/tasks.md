# tri-platform agent — tasks (RECONSTRUCTED 2026-09-17)

**Progress (last recorded value)**: `20/56 complete (0.7 dev-half; 0.1; 1.1–1.6; 2.1–2.4; 3.3/3.5/3.6/3.8 …; 3.1/3.2/3.4/3.7 …; 3.2 is the Linux half only, darwin.py deliberately not created; 3.6 is CLI-half only, constitution split deferred)` [verbatim: T#80, as of the Wave 3b bookkeeping on 2026-09-16].
**Progress at the loss (reconstructed)**: the 20 above, plus the macOS half of 3.2 landed on `feat/tri-platform-macos` (`4b7618e5`). Wave 4 had 4.1, 4.2 and 4.3 implemented but uncommitted [inferred: C:4b7618e5, D]. Whether the counter was updated for any of these is [unknown].

Status legend (this reconstruction): **DONE+PUSHED** (commit SHAs given) · **DONE-ON-DISK-ONLY** (implemented, not on GitHub) · **IN PROGRESS** · **NOT STARTED** · **UNKNOWN**.
Format: the original blocks read `- [ ] **Task N.N: title**` followed by indented `- Files:` / `- Do:` / `- Done when:` / `- Go/no-go:` / `- Depends on:` lines, plus dated `**Status …:**` / `**Addendum …:**` lines [verbatim: H §15; T#77]. Blocks marked **[verbatim: H §15]** are copied byte for byte from the handoff, including their 2026-09-15 corrections. The `- Status (reconstructed):` line under each block is new. The original 2026-09-16 status and addendum lines are lost. Where a bookkeeper report summarised one, the summary is quoted with its source. Line numbers inside verbatim blocks are hints anchored at `a49ed4cc` [verbatim: H §15].

---

## Wave 0 — spikes and metric

Seven tasks, 0.1–0.7 [inferred: the Progress string names 0.1 and 0.7; H §15 has 0.2, 0.4, 0.6; Task 4.4 depends on 0.3]. Spike files were `spikes/{fleet-floor,pytest-matrix,macos-tcc,linux-capture,user-session,notarize}.md` [verbatim: T#2].

- [x] **Task 0.1: LOC metric** [title inferred]
  - Files: `scripts/checks/loc.sh`, `scripts/checks/loc-baseline.txt`, `.github/workflows/loc-metric.yml` [verbatim: C:6ef1b057]
  - Do: print the line delta on every PR, non-blocking, measured against the merge-base [verbatim: C:6ef1b057 "every PR, non-blocking, merge-base delta"]. Full text [unknown].
  - Done when: [unknown]
  - Depends on: [unknown]
  - Status (reconstructed): **DONE+PUSHED**. `6ef1b057`; checkout pin aligned in `62686311` [verbatim: C:62686311].

- [ ] **Task 0.2: macOS capture + TCC spike** (gates waves 3, 4, 5, 8)  **[verbatim: H §15]**
  - Files: `dev/active/tri-platform-agent/spikes/macos-tcc.md` (throwaway branch for code)
  - Do: on a real Sequoia box, test in order: (a) an ad-hoc-signed Tauri `.app` started by a LaunchAgent, granted Screen Recording, shelling `/usr/sbin/screencapture -x -t jpg` — **record whether TCC attributes the capture to the calling bundle or to `screencapture`**; (b) the same app using an in-process ScreenCaptureKit binding; (c) a LaunchDaemon-spawned `python … mss` (expected to fail — record it). For whichever succeeds, re-sign the app with the same team id, replace it, reboot, re-capture. Also record: (i) a child binary placed inside `owlette.app/Contents/MacOS/`, signed with the same Team ID, run under hardened runtime with no App Sandbox keys — does it inherit the bundle's Screen Recording and Accessibility responsibility, and does the answer differ between a `posix_spawn` from the app and a `launchctl asuser` spawn from the daemon? (`com.apple.security.inherit` is an App Sandbox key and plays no part in TCC.) This decides swoop's macOS spawn path, cross-plan decision C2. (ii) the Sequoia 30-day screen-recording re-authorisation behaviour unattended: does the prompt fire, does it end an in-flight ScreenCaptureKit stream, does a PPPC `ScreenCapture` profile or `forceBypassScreenCaptureAlert` suppress it (Q15). (iii) the measured line count of the capture and encode modules for the Wave 8 ledger. Also answer the mirror question: which process is TCC-responsible for a managed `.app` launched by the daemon, and does a disclaiming `posix_spawn` (`responsibility_spawnattrs_setdisclaim`) restore its own identity — the customer's app, not owlette, must own its Screen Recording and Accessibility grants.
  - Done when: the file records, for each of (a)(b)(c): granted/denied, time-to-first-jpeg, and whether the grant survived an app replacement **and** a reboot; plus the child-process responsibility answer.
  - Go/no-go: (a) works → `capture.rs` ~90 lines, no new crate. (a) fails, (b) works → `capture.rs` ~250 lines + one crate, owner Q5. Both fail → macOS ships `capabilities.screenCapture: 0` (owner Q6).
  - Depends on: nothing.
  - Status 2026-09-25: **(a) and (b) MEASURED on the MBA over ssh** — (a) works: 348 ms to a 3420×2214 JPEG on the app's own grant, (b) 77 ms; an ad-hoc grant dies on rebuild; reboot survival and (c) still owed (need the owner at the laptop). Results in `spikes/macos-tcc.md`. Go: `capture.rs` ≈ 90 lines, no new crate.
  - Status (reconstructed, before that): **NOT STARTED** as written. The Mac ran no capture/TCC spike. Its research-only findings are in H §16.3 (see `spikes/macos-tcc.md`). The original file was a stub: "macos-tcc.md is a stub: no Mac here" [verbatim: W4:4.5].

- [ ] **Task 0.3: Linux capture spike** [title inferred]
  - Files: `dev/active/tri-platform-agent/spikes/linux-capture.md` [inferred: T#2]
  - Do: [unknown]. What survives: the plan concludes "v1 is X11-only per spike 0.3" [verbatim: H §14 C2], and Tasks 4.4/8.x depend on it [verbatim: H §15 Task 4.4].
  - Done when: [unknown]
  - Depends on: [unknown]
  - Status (reconstructed): **UNKNOWN**. The Progress string does not list it as complete, yet the file had content that Wave 4 agents were told to read [verbatim: W4:4.5]. See `spikes/linux-capture.md`.

- [ ] **Task 0.4: user-unit spike** (gates decision 2, wave 4)  **[verbatim: H §15]**
  - Files: `dev/active/tri-platform-agent/spikes/user-session.md`
  - Do: prove a LaunchAgent and `systemctl --global enable` start a stub Tauri app on auto-login after reboot; that `tauri-plugin-single-instance` (D-Bus name on Linux, `NSDistributedNotificationCenter` on macOS) folds a second launch; that `tauri-plugin-notification` delivers from a signed bundle; and that root can spawn a GUI child as the console user on both. Record the tested image's display manager, session type (`XDG_SESSION_TYPE`) and DE, and the exact env dict the GUI child needed (`XAUTHORITY` above all — GDM does not write `~/.Xauthority`).
  - Done when: `tmp/tray.pid` exists after reboot on both OSes, a notification renders, and a root-spawned GUI child renders. after `systemctl --global enable owlette-desktop` and a reboot, `systemctl --user status owlette-desktop` reports `active (running)` — not `condition failed` — on the display manager recorded in the spike, and the spike records whether the DE imports `DISPLAY`/`XAUTHORITY` into the user manager before `graphical-session.target` starts. on the same image a second account and the display manager's own user show `condition failed` for the desktop unit, not a five-second restart loop; on macOS the spike records whether both labels appear in Login Items & Extensions after a `.pkg` install, whether a standard user can toggle them off, and whether the off state survives a reboot and `launchctl kickstart`.
  - Go/no-go: pass → decision 2 as written. Fail on Linux → the daemon spawns the app via the decision-4 console-user path, +15 lines; `dbus-user-session` may become a `.deb` dependency.
  - Depends on: nothing.
  - Status 2026-09-25 (macOS half, MBA over ssh): the Tauri app **bundles on macOS** (`owlette.app`, 14 MB, ad-hoc `owlette_desktop-<hash>` identifier, no `LSUIElement`, so a Dock icon shows — Wave 5); started from a LaunchAgent with `OWLETTE_DATA_ROOT` it **writes `tmp/tray.pid` = its pid** and `tmp/json.lock`; a second launch while one runs is **folded into the first** (single-instance holds); without an install it logs the `/Library/Application Support/Owlette` refusals and stays in the tray. `launchctl bootout` (SIGTERM) leaves `tray.pid` behind — the liveness check must keep tolerating a stale pid on posix. Reboot / auto-login and notification delivery still owed (need the owner at the laptop).
  - Status (reconstructed, before that): **UNKNOWN / partly covered.** Not in the Progress string. `spikes/user-session.md` had content [verbatim: W4:4.5]. The Linux kiosk VM later measured parts of it: GDM + Xorg, `XAUTHORITY=/run/user/1000/gdm/Xauthority`, a root-spawned GUI child rendering [verbatim: H §6, T#288, T#166]. The macOS half was never run. Background Task Management / Login Items research is in H §16.3.

- [ ] **Task 0.5: pytest matrix spike** [title inferred]
  - Files: `dev/active/tri-platform-agent/spikes/pytest-matrix.md` [inferred: T#2]
  - Do / Done when / Depends on: [unknown]
  - Status (reconstructed): **UNKNOWN**. Not in the Progress string; Wave 2's three-OS CI matrix (2.4) landed regardless [inferred: C:6ef1b057].

- [ ] **Task 0.6: notarization timing spike** (gates wave 5)  **[verbatim: H §15]**
  - Files: `dev/active/tri-platform-agent/spikes/notarize.md`, scratch workflow branch, `scripts/env-manifest.json` (register the eight Apple secrets: `APPLE_CERT_P12_BASE64`, `APPLE_CERT_PASSWORD`, `APPLE_INSTALLER_CERT_P12_BASE64`, `APPLE_INSTALLER_CERT_PASSWORD`, `APPLE_TEAM_ID`, `APPLE_API_KEY_ID`, `APPLE_API_ISSUER_ID`, `APPLE_API_KEY_BASE64`)
  - Do: with the Apple Developer Program enrolment from Q4 in hand (this task cannot start without it — a stub `.pkg` must be Developer-ID signed to be notarized), submit a **representative** signed `.pkg` — an arm64 python-build-standalone runtime with the POSIX-installable subset of `agent/requirements.txt` pip-installed into it (skip `pywin32`/`wmi`), every Mach-O signed inside-out with `--options runtime --timestamp` and the Developer ID Application identity, the `.pkg` signed with the Developer ID Installer identity — not a stub: the notary service rejects any nested unsigned executable and a stub predicts neither upload nor scan time to `notarytool --wait` five times from a GitHub macOS runner; measure submit→staple p50/p95 against `build-installer.yml:58`'s 30-minute cap and the sign-before-digest constraint at `:21-25`.
  - Done when: p50/p95 recorded and the job graph drawn (three build jobs → one digest+release job); the eight secrets exist in the manifest with `must-match` class where applicable.
  - Go/no-go: p95 < 20 min → notarize inside a dedicated 60-minute macOS build job. Over → notarization is a manual runbook step and SLSA subjects are computed on the stapled bytes afterwards.
  - Depends on: owner Q4 answered (enrolment + a stable team id).
  - Status (reconstructed): **NOT STARTED**. Blocked on owner Q4 [verbatim: H §11].

- [~] **Task 0.7: fleet-floor spike** [title inferred]
  - Files: `dev/active/tri-platform-agent/spikes/fleet-floor.md` [inferred: T#2]
  - Do: establish the agent version floor of the dev and prod fleets [inferred: C:6ef1b057 "dev fleet floor recorded (prod unreadable)"]. It gates 1.2(d) (the legacy-migration deletion) and Q20's route retirement [inferred: C:6ef1b057, T#2].
  - Done when / Depends on: [unknown]
  - Status (reconstructed): **PARTIAL**, the "dev-half" [verbatim: T#80]. Still owed: "prod machines list for 1.2(d)" [verbatim: T#2]. The prod API key is installer-scoped only (CLAUDE.md), so prod machines could not be read.

---

## Wave 1 — pre-port sheds (Windows-only, no behaviour change)

Six tasks, 1.1–1.6, all complete [verbatim: T#80 "1.1–1.6"]. Everything below is inferred from `C:6ef1b057`'s Wave 1 paragraph. Which item carries which number is **[unknown]**, except 1.2(d) and 1.3.

- [x] **Task 1.1 – 1.6** (numbering per item [unknown])
  - Items landed [verbatim: C:6ef1b057]:
    - (a) exe-icon cascade deleted (`exe_icon.rs`, `png.rs`, `useExeIcon`);
    - (b) `OwletteService` no longer subclasses `ServiceFramework`; `MockService` and the dead `__init__` folded into `_init_state()`; an `owlette_runner.py --debug` shim;
    - (c) **legacy screenshot pipeline B deleted**: the crash, hoot and live-view callers moved onto `screenshot_capture.capture_and_upload` with per-caller budgets and an `include_image` path for hoot's image block;
    - (d) dead web modules and validators deleted;
    - (e) `DisplayLayoutPanel`'s private listeners replaced by the machines subscription plus a scoped `useCommandResult` hook;
    - (f) GPUtil replaced by nvidia-ml-py (v2 memory info, so VRAM-used matches nvidia-smi);
    - (g) dead `.bat` files and the PyInstaller spec removed;
    - (h) `_auth_manager` now derives from the Firebase client (owner ruling Q19).
  - **Task 1.2(d)**, the legacy-migration deletion: **deferred**, prod floor unknown [verbatim: C:6ef1b057; T#2].
  - **Task 1.3**, whose web half is the `POST /api/agent/screenshot` route deletion: **Status 2026-09-15: held, patch** [verbatim: T#2 "1.3 status (held, patch)"]. The web-side retirement is held in `patches/task-1.3-route-deletion.patch` until the 3.4 agent is the fleet floor (Q20) [verbatim: C:6ef1b057]. **The patch file is lost.**
  - Status (reconstructed): **DONE+PUSHED** in `6ef1b057` (PR #150, open), apart from the held and deferred parts above.

---

## Wave 2 — the osadapter seam, data root, import guard, three-OS CI

Four tasks, 2.1–2.4 [verbatim: T#80]. 2.1 is the Protocol [verbatim: H §15 Task 3.2 "Task 2.1 spelled the operation `capture_screen(path)`"] and 2.4 is the CI matrix [verbatim: H §15 Task 3.4 addendum "Task 2.4 landed the three-OS matrix"]. Whether 2.2 is the data root and 2.3 the guard, or the other way round, is [unknown].

- [x] **Task 2.1: `osadapter` package, Protocol, Windows arm, contract test** [title inferred]
  - Files: `agent/src/osadapter/__init__.py`, `agent/src/osadapter/win.py`, `agent/tests/unit/test_osadapter_contract.py` [verbatim: C:6ef1b057]
  - Do: define the 19-operation Protocol (`desktop_process_name()` was added as "a 16th adapter operation" per decision 2, so the count grew during planning) with `NotSupportedHere`, PEP 562 `__getattr__`, and a Windows arm that delegates the service-bound rows [verbatim: H §13 decisions 2–3, H1 §4]. Capability-gated features get no adapter row [verbatim: decision 3].
  - Done when: [unknown] (a shared contract body parametrised by adapter [verbatim: H1 §4])
  - Status (reconstructed): **DONE+PUSHED** `6ef1b057`. Corrected later: Task 3.2 widened `capture_screen(path)` to `capture_screen(monitor, *, executor, timeout_s)` [verbatim: H §8 item 4].
- [x] **Task 2.2 / 2.3: data-root routing + AST import guard** [numbering and titles inferred]
  - Files: `shared_utils.get_data_path()` → `osadapter.data_root()` everywhere; `OWLETTE_DATA_ROOT` (Python side); `agent/tests/unit/test_data_root.py`; `agent/tests/unit/test_no_platform_imports.py` + `agent/tests/fixtures/platform_guard/**` (negative-control fixtures) [verbatim: C:6ef1b057]
  - Do: route every data-root lookup through the adapter; add an AST guard that fails a module-scope import of any Windows-only module, of `osadapter.win` or of `tools_windows` from a non-exempt file, with rules 1–4 and a grandfather list [verbatim: H §3; T#2]
  - Status (reconstructed): **DONE+PUSHED** `6ef1b057`.
- [x] **Task 2.4: three-OS CI matrix** [title inferred]
  - Files: `.github/workflows/agent-tests.yml`, `agent/requirements.txt` (`sys_platform` markers), `agent/tests/conftest.py` (`@pytest.mark.windows` + collection hook) [verbatim: C:6ef1b057; T#2]
  - Do: run the suite on windows-latest, macos-15 and ubuntu-24.04, all legs gating. The POSIX legs carry `OWLETTE_DATA_ROOT=/tmp/owlette-data` and 18 transitional `--ignore` entries until 3.4. Convert 15 skipifs to `@pytest.mark.windows` and delete the pywin32 stub rig [verbatim: C:6ef1b057; T#2].
  - Status (reconstructed): **DONE+PUSHED** `6ef1b057`, with `9e1905cc` (CI round 1: `test_process_lookup.py` windows-marked). **Addendum 2026-09-15 (from the 2.4 review)** was carried into Task 3.4's block (see below) [verbatim: H §15].

---

## Wave 3 — identity, tool split, CLI pins, roost roots; then the POSIX arms (3b)

Wave 3 ran 3.3/3.5/3.6/3.8 on Windows first, "run ahead of 3.1/3.2 which need a POSIX host" [verbatim: C:6ef1b057]. Wave 3b was the Linux lane: 3.1 → 3.2 → 3.4 → 3.7 [verbatim: T#77].

- [ ] **Task 3.1: `osadapter/posix.py`**  **[verbatim: H §15]**
  - Files: `agent/src/osadapter/posix.py` (new), `agent/src/shared_utils.py` (`_CrossProcessLock` `:44-96`, tray-liveness guard `:924`), `agent/src/owlette_service.py` (tray-liveness guard `:2135`)
  - Do: shared POSIX implementations: data root, console-user resolution, session env (`DISPLAY`, `WAYLAND_DISPLAY`, `XDG_RUNTIME_DIR`, `DBUS_SESSION_BUS_ADDRESS`), `spawn_as_user`, `launch_managed_process` (`Popen(user=, group=, extra_groups=, start_new_session=True, env=)` — no `preexec_fn`, unsafe in a threaded daemon), job-file `run_job` client for the desktop job runner (typed `desktop_not_running` on timeout), `desktop_process_name()` → `owlette-desktop` with both tray-liveness comparisons (`shared_utils.py:924`, `owlette_service.py:2135`) re-pointed at the 2.1 operation, one helper called from `ensure_data_directories` that applies decision 4's data-root mode table (`ipc/` 0770 root:<group>), and `json_lock()` as `flock(2)` on `<data_root>/tmp/json.lock` — give `shared_utils._CrossProcessLock` a POSIX branch that calls it (the Rust side lands in 4.3; both writers must move together or config writes race as lost updates). Resolve `XAUTHORITY` from the graphical session leader's `/proc/<pid>/environ` (leader from `loginctl show-session -p Leader`), falling back to `$HOME/.Xauthority` only when the leader carries none; `console_user()` returns None when there is no GUI session (macOS `stat -f%Su /dev/console` is `root`; Linux has no active graphical `loginctl` session) and every caller treats None as "no interactive session". `ensure_data_directories` creates `ipc/swoop/` 0770 root:<group> beside `ipc/`. `ensure_data_directories` also creates `logs/swoop/` 0770 root:<group> — the one log directory a kiosk-user process writes.
  - Done when: `test_osadapter_contract.py` passes on macos-15 and ubuntu-24.04, including a two-process concurrent-writer test on the JSON lock; a root-spawned `xdpyinfo` opens the console user's display on the ubuntu leg; tray liveness passes on a POSIX box running `owlette-desktop`. a managed launch issued while the alert, config-push and roost-scrub threads are running returns a live pid 100/100 times; `systemctl restart owlette-agent` / `launchctl kickstart -k system/app.owlette.agent` with a managed process running leaves that pid alive and the agent re-adopts it (negative control: a unit/plist without `KillMode=process` / `AbandonProcessGroup` fails this).
  - Depends on: 2.1, 0.4.
  - Status (reconstructed): **DONE+PUSHED**. `fc330739` + `21ad3fea` + `dd7b5106` on `feat/tri-platform-linux`, merged via #167 (`47e5cae0`). Summary of the lost lines:
    - **Status 2026-09-16 (Wave 3b, Linux lane)**: the Status line recorded what landed, every deviation, the fixer rounds, the rejections, the unverifiable list, and suite counts "3.1 Win 1491/51 · Lin 1004/113" [verbatim: T#80].
    - Deviations the implementer reported [verbatim: T#69]:
      - `_CrossProcessLock` owns the flock on every OS and `json_lock()` returns it.
      - POSIX coverage is a `TestPosix` class, not an `ADAPTERS` row.
      - `get()` does not fall back to posix on darwin.
      - `ensure_data_directories` also creates `ipc/`, `ipc/jobs/` and `ipc/results/`.
      - `harden_data_root` creates `tmp/json.lock` 0660 when absent.
      - `config/machine_id` joins the mode table (0640 + group).
      - Popen handles are kept and reaped.
    - **Addendum (dated 2026-09-15/16, exact date unknown)**: `chgrp -R` of the cortex CLI cache; the CLI is 0o750 [verbatim: T#2; T#62].
    - **Addendum 2026-09-16 (close review)**: the `open_new_file()` temp discipline is required for every root write into the group-writable tree; 3.1's `systemctl restart` clause belongs to 5.2 [verbatim: T#105].
    - **Addendum 2026-09-16 (VM)**: the real source of `session_env` is an in-session process (the scope's `cgroup.procs`, then an owner-filtered `/proc` walk, then the whole `user@<uid>.service` subtree; the leader was GDM's root PAM worker). `Class == 'user'` is required (at the greeter logind lists `Class=greeter`). Warning for macOS: "the macOS lane must give `_session_display_environ` a darwin arm or `session_env()` there will quietly return the account environment with no display" [verbatim: T#169; H §5].
    - `State in {active, online}` is required; `opening` is not a seat [verbatim: T#199, T#209].
    - VM-proven: the mode table 15/15; unit-restart survival with `KillMode=process` (negative control `control-group`); root `xdpyinfo` exit 0 [verbatim: T#169, T#202].
    - macOS half: the `darwin` arms of the four private helpers landed in `4b7618e5` [verbatim: C:4b7618e5]. Still owed on macOS: the root checks in H §16.4 items 1, 2, 8.

- [ ] **Task 3.2: `osadapter/darwin.py` and `osadapter/linux.py`**  **[verbatim: H §15]**
  - Files: `agent/src/osadapter/darwin.py` (new), `agent/src/osadapter/linux.py` (new), `agent/src/screenshot_capture.py`, `agent/src/machine_commands.py`, `agent/src/osadapter/win.py`, `agent/src/shared_utils.py` (metric helpers), `agent/src/sync_assembler.py`, `agent/tests/unit/test_sync_assembler.py`
  - Do: `launchctl` vs `systemctl` service control; `IOPlatformUUID` vs `/etc/machine-id`; `system_profiler SPApplicationsDataType` vs `dpkg-query`; `softwareupdate -l` vs `/var/run/reboot-required` (both off-loop); `osascript` vs the notify job; `shutdown -r` vs `systemctl reboot`; capture transport per spikes 0.2/0.3. Linux: a `session_type()` probe (`XDG_SESSION_TYPE`, falling back to `WAYLAND_DISPLAY`/`DISPLAY` presence); `capture_screen()` raises `unsupported_on_platform` on a non-x11 session instead of returning a black frame. Wire the surviving capture pipeline to the adapter without a new module: **first widen the seam 2.1 sealed** — Task 2.1 spelled the operation `capture_screen(path)` and its contract test pins that signature, but neither arm can honour it: change the Protocol row to `capture_screen(monitor, *, executor, timeout_s)` returning the `{outputDir, files, stdout}` dict `capture_in_user_session` parses, update the contract test and the Windows arm in the same change (correction 2026-09-15, from the 2.1 review) — then move `_build_capture_code()` (`screenshot_capture.py:65-91`) into `osadapter/win.py`, whose arm keeps today's `execute_in_user_session('python', code, trusted=True)` round-trip byte for byte; the POSIX arm submits a `capture` job through `run_job` and returns the same `{outputDir, files:['screenshot.png'], stdout:'monitors=N'}` dict so `capture_in_user_session`'s parsing is unchanged. macOS: `resolve_exec_target(exe_path)` for `.app` bundles (decision 4), applied at `find_running_process_by_exe`, the `graceful_terminate` callers and the launch-path validation. Give the heartbeat's Windows-shaped metric helpers POSIX arms in place (a `sys.platform` branch, not Protocol rows): `get_cpu_name` (`sysctl -n machdep.cpu.brand_string` / `/proc/cpuinfo`), `_detect_default_gateway` (`route -n get default` / `ip route show default`), `_run_ping` (`ping -c 4 -W 1`, parsing `rtt min/avg/max`), and a module-level `_NO_WINDOW = getattr(subprocess, 'CREATE_NO_WINDOW', 0)`. Roost on POSIX: after `os.replace`, the assembler sets 0755 when the first bytes are `#!`, `\x7fELF` or a Mach-O magic and 0644 otherwise (no `mode` field in the v1 schema — the browser uploader cannot supply one). Both POSIX adapters implement `notify()` by submitting a `notify` job through `run_job` (typed `desktop_not_running` when the app is down) — no `osascript`, which cannot display from a daemon. **Addendum 2026-09-15 (from Task 3.5):** once `osadapter.notify()` exists, remove `show_notification` from `mcp_tools.WINDOWS_ONLY_TOOLS` and give `tools_posix` a `show_notification` arm that calls it — Task 3.5 gated the tool because the operation had no POSIX arm yet. `hardware_profile.collect_dynamic_metrics`'s mount reconstruction uses the id verbatim when it starts with `/` and appends the separator only on the drive-letter branch, so volumes other than `/` stop dropping out of the payload.
  - Done when: each adapter passes the shared contract body on its own CI leg; a Wayland session reports `x11`/`wayland` correctly and captures refuse with the typed error; a real `.app` launches, reports a live pid, survives a crash-restart and terminates gracefully; the assembler test covers both mode branches. every id in `profile.disks` has a matching `disks[id]` entry in the metrics payload on both POSIX legs.
  - Depends on: 3.1.
  - Status (reconstructed): **Linux half DONE+PUSHED** (`fc330739` → #167, `47e5cae0`). **macOS half DONE+PUSHED on `feat/tri-platform-macos`**: `4b7618e5` (darwin.py), `99aa37ef` (`resolve_exec_target`), `9d6473a2` (pending-restart rewrite), `f9fb62c7` (the no-arm gate retired), `6f0a71eb` (test executable), `c2415865` (Q-M1 uninstall). No PR yet. Details of the lost lines:
    - **Status 2026-09-16 (Wave 3b)**: suite counts "3.2 1511/112 · 1085/113" [verbatim: T#80].
    - Rejected by the fixers, do not re-raise: the 19-operation seal, macOS `ping -W`, whole-minute rounding, dropping `.pkgs`, `_unit` vs `tools_posix`, reverting the macOS ignore list [verbatim: T#80].
    - **Addendum 2026-09-16 (close review)**: the conftest `needs_os_arm` / `os_arm` gate keeps macos-15 green until darwin.py lands, then retires itself; the macOS metric arms are real [verbatim: T#103, T#105]. The gate has since been retired (`f9fb62c7`).
    - The macOS deviations from the text (all in H §16.2) [verbatim: HL]:
      - a launchd GUI-domain job replaces `asuser … sudo -u` and the disclaiming spawn;
      - `IOConsoleUsers` replaces `stat /dev/console`;
      - in-process `IOPlatformUUID` with no fallback;
      - a fourth `posix.py` arm (`_xauthority`);
      - a bundle-walk inventory replaces `system_profiler`;
      - a scan-based `cancel_reboot()` with no persisted pid;
      - the `ipc/tcc.json` seam contract.
    - Mac suite: 1542 passed / 216 skipped after `c2415865` [verbatim: HL].
    - Linux Wayland seat and capture refusal: proven on the VM [verbatim: T#169]. Still owed: the macOS root and hardware checks in H §16.4.

- [x] **Task 3.3: machine identity + key-derivation migration** [title inferred]
  - Files: `agent/src/shared_utils.py` (`get_machine_id()`), `agent/src/secure_storage.py`, `firebase_client.py`, `auth_manager.py`, `owlette_cortex.py`, `owlette_service.py`, `configure_site.py`, `agent/tests/unit/test_machine_identity.py` [verbatim: C:6ef1b057 file list; H §13 decision 8 call sites]
  - Do: decision 8. Persist `config/machine_id` and read it through `get_machine_id()` at every identity site; derive the key with no hostname term; re-encrypt once per process, keeping a v1 copy, detecting short writes, and migrating the cortex `apiKeyEncrypted` [verbatim: C:6ef1b057].
  - Done when: [unknown in full]. Clause (d) verifies the `O_NOFOLLOW` + 0600 `.tokens.enc` write on a real POSIX filesystem [verbatim: H1 §4 "Task 3.3 Done-when (d)"].
  - Status (reconstructed): **DONE+PUSHED** `6ef1b057` (+ `9e1905cc`: `config/machine_id` 0o644 → 0o640). `.tokens.enc` 0600 root was proven on the Linux VM (1592 bytes, mode 600 root:root after pairing) [verbatim: T#323]. **Still owed on a Mac** (Task 4.7's Done-when) [verbatim: H §4].

- [ ] **Task 3.4: service wiring on POSIX**  **[verbatim: H §15]**
  - Files: `agent/src/owlette_service.py`, `agent/src/owlette_runner.py`, `agent/src/installer_utils.py`, `agent/src/shared_utils.py` (`graceful_terminate`, `get_python_exe_path`), `agent/tests/unit/test_update_artifact_guard.py` (new)
  - Do: gate the remaining pywin32 imports behind `osadapter`; guard `signal.signal(signal.SIGBREAK, …)` at `owlette_runner.py:286` behind `sys.platform == 'win32'` — SIGTERM is already registered at `:285` and is what launchd/systemd deliver, and the bare `SIGBREAK` attribute raises before `main()` on POSIX; make `start_scm_stop_watcher()` (`owlette_service.py:1616`) a Windows-only no-op and import `win32service` lazily inside `_query_scm_stop_requested`; POSIX self-update via a transient unit (`apt-get install --simulate <path>.deb` as a pre-check (typed `update_unsatisfiable` on failure, current version keeps running), then `systemd-run --unit=owlette-update --collect --setenv=DEBIAN_FRONTEND=noninteractive /usr/bin/apt-get install -y --allow-downgrades <path>.deb` with `dpkg --configure -a` as recovery — `dpkg -i` resolves no dependencies and Wave 8 adds `libva` ones; a held dpkg lock is a deferred, retryable failure / `launchctl submit -l app.owlette.update -- /usr/sbin/installer -pkg <path> -target /` (the label plan.md reserves), so the updater is a launchd job rather than a child in the daemon's process group that `bootout` kills) **on a worker thread, never inline in the command callback**; add the per-family magic checks (`xar!`, `!<arch>`) alongside the existing `MZ` at `:5022-5026`; refuse any artifact not matching the agent's own family. `graceful_terminate()`: skip the `find_windows_by_pid`/`WM_CLOSE` branch off Windows (imports inside it) so POSIX falls through to `terminate()` → `wait` → `kill()`; `get_python_exe_path()` resolves per OS. Gate `_process_cortex_ipc_commands` on `shared_utils.is_cortex_enabled()` so the group-writable `ipc/cortex_commands` queue cannot command the root daemon with hoot off. Lift the 1 MB floor + magic check out of `handle_firebase_command` into `installer_utils.verify_artifact_family(path, os_family)` so it is testable. Re-point the four hardcoded `subprocess.run(['shutdown', …])` sites in `owlette_service.py` (`:6497` scheduled fire, `:6875` manual reboot, `:6914` manual shutdown, `:6932` cancel) onto `osadapter.reboot(delay)` / `shutdown(delay)` / `cancel_reboot()`; POSIX arms use a real countdown (`shutdown -r +1` / `shutdown -h +1`) so `rebootCancellable: true` stays truthful, cancel is `shutdown -c` on Linux and SIGTERM to the recorded `shutdown` pid on macOS (BSD `shutdown` has no `-c`), and `cancel_reboot()` returns success/failure. Give `_clean_shutdown_in_event_log` (`:6611`) a third state — no corroboration source on this platform — so `_classify_startup_session` does not downgrade a POSIX boot to `unexpected_reboot`. `get_python_exe_path()` resolves `<install>/python/pythonw.exe|python.exe` on Windows, `/opt/owlette/python/bin/python3` on Linux and `/Library/Application Support/Owlette/runtime/python/bin/python3` on macOS.
  - Do (addendum 2026-09-15, from the 2.4 review): Task 2.4 landed the three-OS matrix with every leg gating, but the macOS and Linux legs carry per-leg `PYTEST_ADDOPTS` `--ignore` entries for the test modules that import `owlette_service` at module scope (`test_service_shutdown.py`, `test_service_status_file.py`, plus any module the first CI run shows); **this task removes those transitional entries** in `.github/workflows/agent-tests.yml` once `import owlette_service` succeeds off Windows — the three display entries (`test_apply_topology`, `test_display_helper`, `test_display_manager`) are permanent (never-ported per the guard's grandfather list).
  - Done when: `import owlette_service` succeeds on all three CI legs, the agent completes a full main loop as root on macOS and Ubuntu, and a self-update completes without blocking `handle_firebase_command` (asserted by a test that times the callback); a table-driven test feeds `MZ`, `xar!` and `!<arch>` payloads under each `osFamily` and the six mismatches are refused before any execution (negative control: removing the family arm fails the test); with cortex disabled, a JSON file hand-written into `ipc/cortex_commands` as the kiosk user is never executed. a scheduled reboot fires and a cancel aborts it on both POSIX legs; an upgrade whose `.deb` declares a missing `Depends:` either completes by pulling it or leaves the installed version running and reports `update_unsatisfiable` (negative control: the same test fails under `dpkg -i`).
  - Depends on: 3.2, 3.3.
  - Status (reconstructed): **DONE+PUSHED** (`fc330739` → #167). Details of the lost lines:
    - Suite counts "3.4 1539/124 · 1377/129 + IMPORT OK" [verbatim: T#80].
    - Design changes the fixers made [verbatim: T#62]:
      - `COMMAND_DEFERRED` acceptance;
      - update staging in `<data_root>/cache/update` 0700;
      - `execute_in_user_session` refuses off Windows (`unsupported_on_platform`);
      - the reboot countdown is 60 s (`REBOOT_OS_COUNTDOWN_SECONDS`) on Windows too;
      - `_check_display_topology` returns immediately off Windows;
      - `_ensure_display_profile` catches `Exception`;
      - an fcntl dpkg-lock probe.
    - A latent Windows-only bug in `_terminate_processes_for_install` is recorded, not fixed (decision 11) [verbatim: T#62].
    - Rejected, do not re-raise: collapsing the three `os_family` checks; making the 1 s reboot delay honest through a return-value change [verbatim: T#62].
    - **Addendum 2026-09-16 (close review)**: the 14-entry ignore removal is safe on macOS only because of the conftest gate; the no-ignore collection evidence keeps the four display entries [verbatim: T#105].
    - **Addendum 2026-09-16 (VM)**: the seatless/escalation semantics; the seat rule at the single choke point `reached_max_relaunch_attempts`; the loop-thread seat budget; the scout and sentinel gates [verbatim: T#169; H §6].
    - Crash alert suppressed when an app ends with the operator session (`9fa1e069`) [verbatim: C:9fa1e069].
    - Wave 3b changed Windows behaviour in three ways [verbatim: C:fc330739]: reboot/shutdown countdown 30 s → 60 s; the update marker is written before the download; byte-identical `app_states.json` rewrites are skipped.
    - macOS: `57802bce` replaced the keepalive `launchctl submit` updater with a run-once job, and `9d6473a2` rewrote `check_pending_reboot` [verbatim: H §16.1].
    - Still owed: a real `.deb` self-update (needs 5.2) [verbatim: T#169]; everything in H §16.4 on macOS.

- [x] **Task 3.5: hoot tool split** [title inferred]
  - Files: `agent/src/mcp_tools.py` (cross-platform core), `agent/src/tools_windows.py`, `agent/src/tools_posix.py`, `agent/tests/unit/test_tool_surface_split.py` [verbatim: C:6ef1b057]
  - Do: split the tools behind a function-body registration guard. The final shape is 13 tools gated and 6 with POSIX arms, since `show_notification` was un-gated in 3.2 [verbatim: H §4]; at 3.5 it was 14 gated and 5 with POSIX arms [verbatim: C:6ef1b057]. Tool definition fields `os?: OsFamily[]`, `osNotes?` [verbatim: H §12].
  - Status (reconstructed): **DONE+PUSHED** `6ef1b057`. Open disagreement: `tools_posix.manage_windows_service` passes `service_name` verbatim, while `linux._unit` maps it (Log owner item (p)) [verbatim: T#103].

- [x] **Task 3.6: cortex CLI pins per platform** [title inferred]
  - Files: `agent/src/cortex_cli_fetch.py`, `scripts/upload-cortex-cli.mjs`, `docs/internal/cortex-cli-provisioning.md` [verbatim: C:6ef1b057]
  - Do: per-platform cortex CLI pins (`cortex_cli_windows_x64`, `cortex_cli_macos_universal`, `cortex_cli_linux_x64`), still writing the legacy pin [verbatim: C:6ef1b057; H §12].
  - Status (reconstructed): **DONE+PUSHED, CLI half only** [verbatim: T#80]. **Status 2026-09-15**: the constitution split is deferred to 5.1/5.2, and `owlette_cortex.py`'s constitution cwd is untouched [verbatim: T#2, T#62].

- [ ] **Task 3.7: pairing on POSIX (`configure_site.py`)**  **[verbatim: H §15]**
  - Files: `agent/src/configure_site.py`, `agent/tests/unit/test_configure_site.py`, `agent/tests/unit/test_configure_site_headless.py`
  - Do: the add-a-machine flow is Windows-shaped in four places — `win32clipboard` copy of the phrase (`:79-90`), `SetConsoleMode` (`:60-65`), `owlette-host.exe` service control (`:487-531`), `shutdown /r` (`:866-871`) — and mints the Firestore doc id from the hostname at `:553`. Route clipboard/notify through `osadapter` (or drop the clipboard copy off Windows), service control through `osadapter.service_control`, reboot through `osadapter.reboot`, and the doc id through `shared_utils.get_machine_id()`. Browser-open must happen in the user session (`open` / `xdg-open` as the console user), never from the root daemon. Define the POSIX bulk-deploy analogue of `/ADD=<phrase> /SILENT`: a preseed file `<data_root>/config/pairing.json` (or `OWLETTE_ADD=<phrase>`) read by `postinstall`/`postinst`, documented in the installation docs by 6.4. The preseed also carries `kiosk_user` (the account the desktop app runs as); when absent, `postinstall`/`postinst` resolve it from the active graphical session and otherwise print the manual `usermod -aG owlette USER` step rather than guess. Device codes are single-use and a golden image clones `machine_id` and the refresh token, so this preseed pairs one machine; bulk deploy is owner Q14. The preseed is consume-once: `postinstall`/`postinst` rename `config/pairing.json` to `pairing.json.used` on success and skip pairing entirely when `config/config.json` already carries `firebase.site_id`, mirroring `owlette_installer.iss`'s `ShouldConfigureSite`; `OWLETTE_ADD=` is the explicit re-pair opt-in. The four privileged app modes — pair, leave, restart, reboot — become requests the app drops into the 0770 `ipc/` seam (`pair`, `leave`, `reboot` beside the existing job types) that the daemon executes, since the kiosk user cannot write `.tokens.enc` or control the daemon. The seam is a privilege boundary: the daemon accepts a request only when the file is owned by the uid `console_user()` resolves, has no group or world write bit, and carries the one-shot nonce from the root-owned 0640 `ipc/request_nonce` it last wrote; anything else is unlinked and logged. `leave` is removed from the seam — deregistration stays an uninstall-time root operation (`uninstall.sh` / `prerm`) and a dashboard command. `restart` and `reboot` are rate-limited to one per five minutes and each executed verb writes an audit row.
  - Done when: the headless pairing test passes on three legs; a Mac and an Ubuntu box pair via the preseed file with no browser; the dashboard shows the machine with the persisted id. a `reboot` request hand-written into `ipc/` by a second group member is refused and logged; there is no `leave` handler to hand-write (negative control: adding one fails the test).
  - Depends on: 3.3.
  - Status (reconstructed): **DONE+PUSHED** (`fc330739`, `21ad3fea` → #167). Details of the lost lines:
    - Suite counts "3.7 1559/155 · 1427/130" [verbatim: T#80].
    - Design changes [verbatim: T#62]:
      - the `<id>.result` answer channel;
      - nonce publication on the poll;
      - `restart.flag` honoured only when root-owned;
      - single-flight pair;
      - no browser-open arm on any platform.
    - **Addendum 2026-09-16 (close review)**, the Wave 4 writer contract: create the request 0600/0640 with `fchmod` before the rename; remove `<id>.result` only after the terminal event; `tray.rs`'s `restart.flag` write is a silent no-op off Windows [verbatim: T#103, T#105].
    - Plan-text correction: `win32clipboard` and `SetConsoleMode` were already guarded, so that half of the Do was pre-satisfied [verbatim: T#103 item (t)].
    - **Addendum 2026-09-16 (VM)**: 7/7 seam scenarios under a real logind console user; no change needed because the owner check resolves the seat live on its worker; `postinst` must not call `--preseed` synchronously [verbatim: T#169].
    - A real preseed pairing to dev on the VM succeeded on 2026-09-17 02:16 UTC (`pairing.json` → `pairing.json.used`, machine doc id `owlette-kiosk`) [verbatim: T#323].
    - Stale plan text: the Status line's audit-log mode 0640 is really 0600 [verbatim: H §8 item 15].
    - Still owed: a Mac and an Ubuntu box pairing through the packaged path (5.1/5.2).

- [x] **Task 3.8: roost destinations per OS** [title inferred]
  - Files: `agent/src/destination_allowlist.py`, `agent/src/sync_assembler.py`, `agent/src/sync_commands.py`, `web/lib/extractPath.ts`, `web/components/ProjectDistributionDialog.tsx` [verbatim: C:6ef1b057]
  - Do: per-OS default roost roots (macOS `/Users/Shared/Owlette`), the POSIX dangerous-root arm, kiosk-user ownership, and per-OS `extractPath` verdicts [verbatim: C:6ef1b057; H §4].
  - Status (reconstructed): **DONE+PUSHED** `6ef1b057`. **Addendum 2026-09-15/16**: the legacy `~/Documents/Owlette` default root is substituted agent-side off Windows; the macOS carve-out is only `/Users/Shared/Owlette` [verbatim: T#2].

---

## Wave 4 — the desktop app on POSIX

Lanes: `Owlette-wt-tri-w4a` and `Owlette-wt-tri-w4b`, both detached at `4a3de0cd`, created about 19:36 on 2026-09-16 [inferred: T#340, directory mtimes]. Workflow `wf_f23dac91-3bd`; agent labels `impl:4.x`, `review:4.x:<lens>[-r2]`, `fix:4.x` [verbatim: W4:J]. Owner go-ahead: "ok great. are we finished with w3? if so let's start w4" [verbatim: T#336].

- [ ] **Task 4.1: cargo gating, paths, shell_open**  **[verbatim: H §15]**
  - Files: `desktop/src-tauri/Cargo.toml`, `desktop/src-tauri/src/paths.rs`, `desktop/src-tauri/src/shell_open.rs`, `desktop/src-tauri/tauri.conf.json` `desktop/src-tauri/src/tray.rs`
  - Do: move `windows` and `windows-service` under `[target.'cfg(windows)'.dependencies]` (`winresource` is `agent/host`'s build-dependency, not this crate's); replace the `ShellExecuteW` wrapper with the `explorer.exe`/`open`/`xdg-open` ternary already proven at `cli/src/commands/auth.ts:109-110` (−80); per-OS data root honouring `OWLETTE_DATA_ROOT` and reading the env var case-consistently with `agent/host/src/paths.rs:80`; add `bundle.macOS` and `bundle.linux` siblings to the existing android stanza, replacing the inherited `"targets": "all"` with the explicit `["nsis", "app", "deb"]` (decision 12 — `"all"` reaches for dmg, rpm and AppImage tooling) and `signingIdentity: null` (5.1 signs by hand). **Do not** remove `tauri-plugin-fs` (decision 21). All new desktop/web copy is lowercase, colours from tokens, icons from lucide only; `osLabel()` keeps the proper nouns "Windows / macOS / Linux". `tray.rs`: replace `hostname()`'s `%COMPUTERNAME%` read with a per-OS resolution (`gethostname`), and resolve `agent_version()` from the per-OS install root rather than `AGENT_VERSION_REL` under the data root — split `paths.rs` into `data_root()` and `install_root()` and move `AGENT_VERSION_REL` onto the latter.
  - Done when: `cargo check` passes for `x86_64-pc-windows-msvc`, `aarch64-apple-darwin` and `x86_64-unknown-linux-gnu`.
  - Depends on: 0.4.
  - Status (reconstructed): **DONE-ON-DISK-ONLY** in `w4a`, ported into `w4b` [verbatim: W4:4.7 "4.1 has been ported into this lane"; D].
    - Files changed vs `4a3de0cd` [D]: `Cargo.toml` (`windows`/`windows-service` under `cfg(windows)`, `libc` under `cfg(unix)`), `Cargo.lock`, `tauri.conf.json` (`targets: ["nsis","app","deb"]`, a `linux.deb.depends` list, `macOS.signingIdentity: null`, `minimumSystemVersion: "14.0"`), `paths.rs` (`data_root()` + `install_root()`), `shell_open.rs`, `tray.rs` (`gethostname`), `commands.rs`, `desktop/src/lib/ipc.ts`, `desktop/src/components/StatusFooter.tsx`.
    - Gate state reported by the 4.2 lane: on Linux, `cargo check` had 5 errors, all in `json_io.rs` (4.3) and `agent_cli.rs` (4.7), "the wave exit gate the plan already records". `aarch64-apple-darwin` fails in the `objc2-exception-helper` build script under WSL, so it is unverifiable there [verbatim: W4:4.2r2].
    - **Stale against the Mac ruling**: `minimumSystemVersion` should be 15.0 (Q-M2), and H §16.3 asks to confirm the Mach-O is named `owlette-desktop` (`mainBinaryName`).
    - **2026-09-24 (overnight, inline):** the w4a/w4b lanes were never pushed — `dev`'s desktop crate was still Windows-only
      and `feat/tri-platform-macos` is fully merged, so the on-disk work is lost. Re-landed the Windows-verifiable half on
      `tri-platform/desktop-4.1`: `windows`/`windows-service` under `[target.'cfg(windows)'.dependencies]`; `targets:
      ["nsis","app","deb"]`, `macOS.signingIdentity: null`, `minimumSystemVersion: "15.0"`; `paths.rs` `data_root()` per OS
      honouring `OWLETTE_DATA_ROOT` (pure `data_root_from`/`install_root_from` with tests), `install_root()` (`/opt/owlette`,
      `…/Owlette/runtime`, `= data root` on Windows), `compare_key`/containment per OS, unix tests; `shell_open.rs` posix arm
      (`open`/`xdg-open`); `tray.rs` hostname via `HOSTNAME`/`/etc/hostname` off Windows; `agent_version` reads the install
      root. Windows: `cargo test` 119/1 ignored, clippy clean. **Not done:** `#[cfg(windows)]` gating of `service_ctl`,
      `process_ctl`, `startup_link`, `json_io`, `agent_cli` with posix arms/stubs (4.2/4.3/4.7), so the crate still does not
      compile off Windows; the ubuntu/macOS `cargo check` legs (4.6) go in with that. WSL's Ubuntu disk is gone on A4D, so
      the posix legs are CI-only from here.

- [ ] **Task 4.2: service_ctl, process_ctl, startup_link**  **[verbatim: H §15]**
  - Files: `desktop/src-tauri/src/service_ctl.rs`, `desktop/src-tauri/src/process_ctl.rs`, `desktop/src-tauri/src/startup_link.rs` `desktop/src-tauri/src/tray.rs`
  - Do: `#[cfg(windows)]` the SCM/UAC paths (`service_ctl.rs:213-218,259,264,272-296`); add `launchctl print|kickstart|bootout` and `systemctl is-active|start|stop` arms — Linux invokes `systemctl is-active|start|stop owlette-agent` directly as the kiosk user (the D-Bus call polkit checks under `org.freedesktop.systemd1.manage-units`, which the 5.2 rule allows; no `pkexec`, whose own action `org.freedesktop.policykit.exec` the rule never grants and which would prompt); macOS writes a `restart` request into the `ipc/` seam from 3.7 and uses `launchctl print` only for read-only status; no `osascript … with administrator privileges` anywhere; SIGTERM→SIGKILL with the same grace window, capability-gating "graceful close" (no `WM_CLOSE` analogue); three-way autostart returning "managed by the system" on POSIX since the init system owns it (decision 2). `tray.rs` renders the third autostart state ("managed by the system", unchecked and disabled) in `build_menu`/`toggle_start_on_login` where `startup_link` reports it.
  - Done when: start/stop/status and terminate-by-pid work from the tray on all three, and the app relaunches at login on all three. start/stop/status work from the tray **as the unprivileged kiosk user with no password prompt** on Linux (the polkit rule from 5.2). with the polkit rule removed the same call is denied — the rule, not a cached admin session, is what authorises it.
  - Depends on: 4.1.
  - Status (reconstructed): **DONE-ON-DISK-ONLY, IN REVIEW** in `w4b` (files 22:07–22:33). At 23:17 `review:4.2:correctness-r2` started and failed ("Not logged in"). A 4.2-related agent (`ad9515491819cce19`, grepping `service_ctl::start` callers) was mid-run and failed the same way [verbatim: W4:J, W4:4.2r2].
    - Files: `service_ctl.rs`, `process_ctl.rs`, `startup_link.rs`, `tray.rs`, `commands.rs`, `paths.rs`, `desktop/src/lib/ipc.ts` [verbatim: W4:4.2r2; D].
    - Implementer's deviations [verbatim: W4:4.2r2]:
      - (1) Linux status uses one `systemctl show -p LoadState,ActiveState,UnitFileState`, not `is-active`.
      - (2) Controls run `--no-block` and are bounded at 5 s (`CONTROL_TIMEOUT`). Without the polkit rule an in-seat call parks on polkit indefinitely, and on a box whose admin group exists it would put an auth dialog on the kiosk screen.
      - (3) Restart goes through the `ipc/requests` seam on Linux as well as macOS.
      - (4) macOS start/stop return a typed refusal.
      - (5) `startup_link::is_enabled()` returns `Result<bool,String>`.
      - (6) `TerminateMethod` gains `'signaled'` and `ServiceCommandOutcome.method` gains `'systemd'`.
      - (7) `RESTART_FLAG_REL` is `cfg(windows)`.
      - (8) Off Windows the tray's exit leaves the agent running.
    - Verification [verbatim: W4:4.2r2]:
      - Windows: `cargo test` 119 passed / 1 ignored; clippy clean; vitest 489.
      - WSL probe crate: 31 passed.
      - VM as the kiosk user: status without the rule works; stop is refused without the rule (5 s in-seat); with the lab rule stop/start take 115 ms; with the rule removed it is refused again; seam restart moved MainPID 18021→18537 with an audit row; a second restart was rate-limited; terminate-by-pid; autostart `Managed`.
    - Unverifiable: every macOS runtime path; the tray itself on Linux (the crate did not build there yet); relaunch at login (5.1/5.2); a real Windows box [verbatim: W4:4.2r2].
    - Notes for later tasks [verbatim: W4:4.2r2]:
      - 4.7: `App.tsx:462` still writes `tmp/restart.flag`, so the window-menu restart is inert on POSIX; reuse `service_ctl::restart(&paths::data_root())`.
      - 5.2: ship the polkit rule exactly as the lab rule; `owlette-desktop.service` must not carry `Restart=always`.
      - Wave 6: the AppMenu tri-state.

  - **2026-09-24 (overnight, inline, second slice) — `tri-platform/desktop-posix`:** the five win32 modules gated and given
    posix arms so the crate builds on all three: `json_io` takes flock(2) on `tmp/json.lock` (2 s budget, 10 ms retry,
    outcomes as on windows; `libc` is now a direct `cfg(unix)` dependency — it was already in the lock file through tauri);
    `process_ctl` verifies the image (`/proc/<pid>/exe`, `ps -o comm=` on macos), SIGTERM with the graceful window then
    SIGKILL, `TerminateMethod::Signaled`; `startup_link` writes `~/.config/autostart/owlette-desktop.desktop` /
    `~/Library/LaunchAgents/app.owlette.desktop.plist`; `service_ctl` reads `systemctl show` / `launchctl print`, controls
    with `systemctl start|stop --no-block` bounded at 5 s (a hang is reported as the polkit rule missing; the plan's
    deviations 1–2), macos start/stop are typed refusals (deviation 4); `agent_cli` runs the interpreter from the install
    root with the `CREATE_NO_WINDOW` flag windows-only. Frontend unions gain `'systemd'` and `'signaled'`. CI (4.6):
    `desktop-posix` job matrix ubuntu/macos with tauri's gtk/webkit packages, clippy `-D warnings` + tests. **Not done:**
    the restart request through the `ipc/requests` seam (deviation 3; needs the nonce protocol from 3.7 and a tauri
    command — 4.7), relaunch-at-login proof on real boxes, and every macos runtime path (CI compiles and runs unit
    tests only).
    **Merged as PR #212 (`0648b023`, 2026-09-24 ~19:xx UTC)** after three CI rounds (clippy imports/variants,
    the macOS temp-dir symlink in the watcher test); all three `rust build` legs green. The PR sat `UNSTABLE`
    on the external Vercel status only ("Account is blocked", the failover origin answers 402) — dev has no
    required checks, so merged by hand.

- [ ] **Task 4.3: the POSIX job runner**  **[verbatim: H §15]**
  - Files: `desktop/src-tauri/src/jobrunner.rs` (new), `desktop/src-tauri/src/json_io.rs`, `desktop/src-tauri/src/watchers.rs`, `desktop/src-tauri/src/lib.rs`
  - Do: `#[cfg(unix)]` `jobrunner.rs`: watch `ipc/jobs` on the existing 120 ms debounce, execute `capture`/`shell`/`notify`/`launch` job types, honour a 120 s cap and the job's `trusted` flag, write results atomically into `ipc/results/<uuid>/`; POSIX lock in `json_io.rs` = `flock(2)` on `<data_root>/tmp/json.lock`, the same identity 3.1 gave Python; route `notify` to `tauri-plugin-notification` (already a dependency). The `launch` job type spawns the requested executable as a **child of the app** (posix_spawn) so it inherits the bundle's TCC responsibility — this is swoop's POSIX spawn path (cross-plan decision C2). The `launch` job carries `stdin_path` — a file the daemon writes 0640 root:<group> under `<data_root>/ipc/swoop/` (the POSIX analogue of swoop decision 3's fallback, never inside the 0770 `ipc/jobs` tree) — which the runner pipes to the child and unlinks after the child reads to EOF; `result.json` returns the child `pid` so the daemon can reap or kill by pid; a `stdin_path` is accepted only when it resolves inside `<data_root>/ipc/swoop/`, `st_uid == 0` and `st_mode & 0o022 == 0`; anything else is refused with a typed error.
  - Done when: a job file written by hand on macOS and on Ubuntu returns a `result.json` in <300 ms, a malformed job returns a typed error rather than panicking, a concurrent Python + Rust write to `config.json` loses no update, and `cargo test` is green on all three; a `launch` job hands 4 KB to a child on macOS and Ubuntu, the stdin file is gone within 1 s of the read, and the result carries a live pid.
  - Depends on: 4.1.
  - Status (reconstructed): **DONE-ON-DISK-ONLY, fix/verification IN PROGRESS at 23:12** in `w4a` [inferred: D, I].
    - Files vs `4a3de0cd`: new `jobrunner.rs` (1,472 lines, 22:37), `json_io.rs` (`flock(2)` on `tmp/json.lock`), `watchers.rs`, `lib.rs` (`#[cfg(unix)] mod jobrunner`, the `JobRunner` state), `tray.rs`, `Cargo.toml` (adds `[target.'cfg(target_os = "linux")'.dependencies] gdk = "0.18"` for in-process X11 capture, a new direct crate; see Q5) [D].
    - The runner's design, per its header [D]: results in `ipc/results/<id>/result.json` (dir 0750, file 0640); requests accepted only when regular, daemon-uid owned and writable by nobody else; `shell`/`launch` need `trusted`; 120 s cap; 64 KiB request limit; 1 MiB stdin; at most 4 jobs in flight; typed errors `malformed_job`, `unsupported_job`, `untrusted_job`, `capture_failed`, `capture_unsupported`, `notify_failed`, `shell_failed`, `launch_failed`, `stdin_rejected`, `job_timeout`.
    - At 23:12 the orchestrator was running `scratchpad/w43fix/02-test.sh` in WSL. It built a rig crate over `/root/w43fix/desktop/src-tauri/src/{paths,json_io,watchers,jobrunner}.rs`, ran `cargo test`, and checked whether the tests created `/var/lib/owlette/tmp/json.lock` [verbatim: I]. **The WSL copy `/root/w43fix` is lost with the WSL disk**, and no `w4a` file is newer than 22:37. Any 4.3 fix edits made after 22:37 existed only in WSL and are gone [inferred: D, I].
    - Review outcome for 4.3: [unknown].

- [ ] **Task 4.4: capture provider and TCC surface**  **[verbatim: H §15]**
  - Files: `desktop/src-tauri/src/capture.rs` (new), `desktop/src-tauri/src/tcc.rs` (new), `desktop/src-tauri/src/lib.rs` (two `mod` lines + one `generate_handler!` entry), `desktop/src/lib/ipc.ts` (binding), `desktop/src/App.tsx` (banner mount), `desktop/src/components/PermissionBanner.tsx` (new), `agent/src/osadapter/darwin.py`, `agent/src/osadapter/linux.py`
  - Do: implement `capture` per spike 0.2's winning transport; probe screen recording / accessibility / portal availability, expose as an IPC command, render a first-run banner (lowercase copy, token colours) with a one-click deep link to the correct settings pane, and publish the grant state into the seam so the daemon advertises `capabilities.screenCapture`. Linux: `capabilities.screenCapture` is 1 only when 3.2's session probe reports x11 — a Wayland kiosk (Ubuntu 24.04's default session except on the NVIDIA proprietary driver) publishes 0 with the banner reason "wayland session — capture unsupported in v1 (x11 only)", and the same signal gates `capabilities.swoop` once Wave 8 lands. Implement the darwin/linux arms of the `streamer_capable()` operation defined in 2.1 (Linux: the session probe reports x11; macOS: Screen Recording granted) — the swoop plan's Task 2.2 ANDs it with binary presence for `capabilities.swoop`, so a Wayland kiosk never advertises swoop with the binary packaged.
  - Done when: a fresh Mac shows the banner, one click opens the right pane, a capture succeeds after the grant, and the dashboard's capability flips within one heartbeat; an Ubuntu box booted into a Wayland session advertises `capabilities.screenCapture: 0` within one heartbeat and the dashboard renders the reason, not a black frame. with the streamer binary present but `screenCapture` 0, the heartbeat carries `capabilities.swoop: 0`.
  - Depends on: 4.3, 0.2, 0.3. *(Ordered after 4.3 — both edit `lib.rs`.)*
  - Status (reconstructed): **NOT STARTED**. No `capture.rs`, `tcc.rs` or `PermissionBanner.tsx` exists in either lane [D]. The daemon-side TCC contract is fixed by H §16.2 (`ipc/tcc.json`), and H §16.3 adds research amendments.

- [ ] **Task 4.5: desktop frontend per-OS handling**  **[verbatim: H §15]**
  - Files: `desktop/src/components/WindowControls.tsx`, `desktop/src/lib/dropClassifier.ts`, `desktop/src/lib/dropQueue.ts`
  - Do: native decorations on macOS; per-OS entries in `DEFAULT_CLASSIFY_OPTIONS` (`dropClassifier.ts:99`, typed `Required<ClassifyOptions>` — three objects or a partial merge); make `pathKey()` (`dropQueue.ts:148-150`) case-sensitive off Windows.
  - Done when: vitest green and dropping `/Applications/TouchDesigner.app` and `/usr/bin/foo` classify correctly.
  - Depends on: 4.1.
  - Status (reconstructed): **NOT STARTED** (the agent was launched, then lost). `impl:4.5` started in `w4b` at 23:17 and failed at once [verbatim: W4:J]. `WindowControls.tsx`, `dropClassifier.ts` and `dropQueue.ts` are unchanged vs `4a3de0cd` [D]. Brief notes: "vitest green (baseline 489); the three ClassifyOptions objects or a partial merge as the task text allows; pathKey case-sensitive off Windows; native decorations on macOS (code-only here). Keep the diff to the three named files plus tests." [verbatim: W4:4.5]

- [ ] **Task 4.6: Rust CI on three OSes**  **[verbatim: H §15]**
  - Files: `.github/workflows/rust-build.yml` (created by swoop Task 2.5 if that ran first; otherwise new here)
  - Do: extend (or create) the workflow so `desktop/src-tauri` builds and tests on windows/macos/ubuntu, `agent/host` on Windows only, `agent/swoop` per its own plan; MSRV 1.77.2 pinned (or the floor swoop spike 0.2 measured); one job step per crate with `working-directory:` (no workspace; `--manifest-path` from the repo root drops each crate's `.cargo/config.toml` and with it `+crt-static` — swoop Task 2.5); widen `paths:` to `desktop/**`; zizmor conventions. The ubuntu leg installs the Tauri v2 Linux build deps before any cargo invocation (`libwebkit2gtk-4.1-dev libgtk-3-dev libxdo-dev libssl-dev libayatana-appindicator3-dev librsvg2-dev patchelf build-essential`) — the `ubuntu-24.04` image ships none and `webkit2gtk-sys`'s build script fails before a line compiles; no xvfb. The ubuntu leg builds both x86_64 and arm64 (`ubuntu-24.04-arm` runner or cross-compile with `cross`); the macOS leg builds universal2 (`--target universal-apple-darwin`).
  - Done when: the workflow fails on a deliberately mis-`#[cfg]`'d line and passes on `dev`.
  - Depends on: 4.2, 4.3.
  - Status (reconstructed): **NOT STARTED** [D: no workflow changes in either lane]. Amended by the Mac: the macOS leg builds `aarch64-apple-darwin`, not universal2 [verbatim: H §16.3]. The VM probe harness `/tmp/owlette-ctl-probe` was left in place "for 4.6/5.2" [verbatim: W4:4.2r2].

- [ ] **Task 4.7: agent CLI bridge and update marker on POSIX**  **[verbatim: H §15]**
  - Files: `desktop/src-tauri/src/agent_cli.rs`, `desktop/src/lib/serviceHealth.ts`
  - Do: `agent_cli.rs:43` hardcodes `python/python.exe` and `:412` a `C:\ProgramData\…` test path — resolve the interpreter and `configure_site.py` through the per-OS data root from 4.1; `serviceHealth.ts:256-269` reads `logs/update_in_progress.json` written by `update_owlette` — make the path data-root-relative so the POSIX self-update marker from 3.4 is honoured. Resolve the interpreter through `get_python_exe_path()` (install root, not the data root); pairing, leave and restart go through the `ipc/` requests from 3.7 rather than running `configure_site` as the kiosk user. The macOS `<install>` root is `/Library/Application Support/Owlette/runtime` (Task 5.1), never the app bundle.
  - Done when: the desktop app can run the pairing CLI on macOS and Ubuntu and shows the "updating" state during a POSIX self-update. a Mac pairs from the app's join dialog and `.tokens.enc` lands 0600 root.
  - Depends on: 4.1.
  - Status (reconstructed): **NOT STARTED** (the agent was launched, then lost). `impl:4.7` started in `w4b` at 23:17 and failed [verbatim: W4:J]. `agent_cli.rs` and `serviceHealth.ts` are unchanged [D]. The brief's added notes [verbatim: W4:4.7]:
    - Resolve the interpreter the way `shared_utils.get_python_exe_path` does (`/opt/owlette/python/bin/python3` on Linux; the VM lab uses `/opt/owlette/venv/bin/python`, so honour the packaged path first and do not hardcode the venv).
    - `configure_site.py` resolves through the install root; `serviceHealth.ts` reads `logs/update_in_progress.json` relative to the data root.
    - On POSIX the bridge is the seam client: the `pair` verb, with the daemon spawning `configure_site.py --json-progress` as root and streaming JSON lines into `<id>.result`. Reuse 4.2's request writer.
    - VM proof: the `restart` verb end to end, and the `pair` path with a nonsense phrase only (the VM is already paired).

---

## Wave 5 — packaging and release

Known tasks: 5.0, 5.1, 5.2, 5.3, 5.6 [verbatim: H §15 Task 5.1 "Depends on: 3.4, 3.7, 4.4, 5.0, 0.6"; H §15 Task 5.3; T#2]. 5.4 and 5.5 presumably exist but are [unknown].

- [ ] **Task 5.0**: [unknown]. A dependency of 5.1 [verbatim: H §15]. Status: **UNKNOWN / not started** [inferred].

- [ ] **Task 5.1: macOS `.pkg`**  **[verbatim: H §15]**
  - Files: `agent/build/macos/build.sh` (new), `agent/packaging/macos/app.owlette.agent.plist` (new), `agent/packaging/macos/app.owlette.desktop.plist` (new), `agent/packaging/macos/postinstall` (new), `agent/packaging/macos/distribution.xml` (new), `agent/packaging/macos/entitlements.plist` (new) `agent/packaging/macos/preinstall` (new), `agent/packaging/macos/uninstall.sh` (new, shipped inside the payload at a documented path) `agent/packaging/macos/owlette-background-items.mobileconfig` (new; off-metric, declarative)
  - Do: universal2: two python-build-standalone payloads (arm64 + x86_64, selected by `uname -m`). Start with `npm ci && npx tauri build --bundles app --target aarch64-apple-darwin` in `desktop/` to produce `owlette.app` (the bundle TCC binds the grant to). Sign every Mach-O in the payload inside-out — the bundled interpreter and every `.so` — then the app itself, all with the Developer ID Application identity, hardened runtime and `com.apple.security.cs.disable-library-validation` (plus allow-dyld-environment-variables if the launcher sets `PYTHONHOME`); LaunchDaemon + LaunchAgent plists; `productbuild` → `productsign` with the Developer ID Installer identity → `notarytool --wait` → `stapler`; verify the app with `codesign --verify --deep --strict` and the `.pkg` with `pkgutil --check-signature` + `spctl -a -vvv -t install` (`codesign --verify` does not work on packages). `postinstall` creates a dedicated `_owlette` group, adds the kiosk user to it, applies decision 4's data-root mode table (root 0750 root:`_owlette`, `ipc/` 0770 root:`_owlette` — never `staff`, which is every logged-in user), pre-creates `tmp/json.lock`, applies the pairing preseed from 3.7, and activates both jobs immediately: `launchctl bootstrap system /Library/LaunchDaemons/app.owlette.agent.plist`, and `launchctl bootstrap gui/<uid> …desktop.plist` for the console user when `stat -f%Su /dev/console` is not `root` (a plist in a Launch* directory is inert until bootstrapped). `distribution.xml` carries `<options hostArchitectures="arm64"/>` and `<allowed-os-versions><os-version min="14.0"/></allowed-os-versions>` so the arm64-only payload refuses an Intel Mac or an old release instead of crash-looping under `KeepAlive`. Upgrade path: on an upgrade the labels are already bootstrapped, so `preinstall` runs `launchctl bootout system/app.owlette.agent || true` and `launchctl bootout gui/<uid>/app.owlette.desktop || true` first, and each `bootstrap` is written `launchctl bootstrap … || launchctl kickstart -k <domain>/<label>` (bootstrap on a loaded label exits non-zero and would fail the package); on upgrade (an existing `config/config.json`) skip group creation, kiosk-user resolution and pairing — apply only the mode table and the unit reload; no maintainer-script step may return non-zero on the upgrade path. The daemon plist carries `AbandonProcessGroup=true`. The OS-version guard goes inside `<volume-check>` — `<volume-check><allowed-os-versions><os-version min="14.0"/></allowed-os-versions></volume-check>` — where Installer honours it (a top-level element is silently ignored). `postinstall` applies `pmset -a sleep 0 displaysleep 0 disksleep 0`. `uninstall.sh` (~60 lines): `configure_site.py --leave` first so the machine deregisters and reports offline, then bootout both jobs, delete both plists and `/Applications/owlette.app`, and the data root only with `--purge` (default keeps it, mirroring the Windows silent uninstall), then `dseditgroup -o delete _owlette`. Payload layout, before the signing sentence: `/Library/Application Support/Owlette/runtime/python` (arm64 python-build-standalone), `.../runtime/agent/src`, `.../runtime/VERSION` and `.../runtime/uninstall.sh`, all root:wheel 0755 and outside any admin-writable directory; the LaunchDaemon's `ProgramArguments` are `.../runtime/python/bin/python3 .../runtime/agent/src/owlette_runner.py`; `/Applications/owlette.app` holds only the GUI and `owlette-swoop`. Ship a `com.apple.servicemanagement` profile whose Rules use `RuleType: TeamIdentifier` plus `LabelPrefix: app.owlette.` so both background items are managed and non-toggleable on MDM-enrolled Macs (Q16); without MDM a standard user can switch them off in Login Items & Extensions, documented in 6.4. Universal2: two python-build-standalone payloads (`aarch64-apple-darwin`, `x86_64-apple-darwin`) selected at runtime by `uname -m`, the Tauri app built `--target universal-apple-darwin`, `distribution.xml` `hostArchitectures="arm64,x86_64"`, and the min-OS floor per architecture (Intel Macs stop at the last Intel-supported release).
  - Done when: a stapled `.pkg` installs on clean Sonoma and Sequoia VMs, both verifications pass, the agent pairs via the preseed, heartbeats and appears in the dashboard with `osFamily: 'macos'`; `launchctl print system/app.owlette.agent` reports the job running before any reboot; the installer refuses on an Intel Mac and below the floor with Installer's own message; after one reboot a `capture` job round-trips through `ipc/` as the kiosk user. installing the new version over a running previous one leaves the daemon serving the new version within 60 s with `installer` exiting 0 and `logs/update_in_progress.json` consumed; the stapled `.pkg` is refused on a macOS 13 VM and on an Intel Mac (observed); the kiosk neither sleeps nor blanks over an 8-hour unattended run; `uninstall.sh` returns a clean Sequoia VM to a no-owlette state and the machine shows offline-and-removed in the dashboard. moving `/Applications/owlette.app` to the Trash leaves the daemon running and heartbeating; with the profile installed both labels show as managed and non-toggleable, and without it the toggle's effect is recorded.
  - Depends on: 3.4, 3.7, 4.4, 5.0, 0.6.
  - Status (reconstructed): **NOT STARTED** (blocked on Q4 for signing). Amended from the Mac [verbatim: H §16.3]: arm64 only with the floor at 15.0 (Done-when VMs are Sequoia + Tahoe, refusal observed on Sonoma); `AssociatedBundleIdentifiers` in both plists; sign the bundled interpreter with the Team ID; no `/bin/sh` wrapper; strip xattrs (macOS 27 refuses quarantined plists); `syspolicy_check` / `gktool scan`; `disable-library-validation` only if something is pip-installed on the device; `NSLocalNetworkUsageDescription`. The macOS self-update is now a run-once plist job (`57802bce`), not `launchctl submit`.

- [ ] **Task 5.2: Linux `.deb`** [title inferred]
  - Files: [unknown]. Probably `agent/packaging/linux/**`, `agent/build/linux/**` [inferred: H1 §1 file-ownership list]
  - Do (fragments that survive): x86_64 and arm64 `.deb` for Ubuntu 24.04 and Raspberry Pi OS Bookworm [verbatim: decision 12].
    - `postinst` applies decision 4's mode table, pre-creates `tmp/json.lock`, and applies the preseed. It must not call `--preseed` synchronously [verbatim: H §7; T#169].
    - A polkit rule scoped to `owlette-agent.service` and group `owlette` (action `org.freedesktop.systemd1.manage-units`, `subject.isInGroup("owlette")`, nothing wider) [verbatim: H §13 decision 4; W4:4.2r2].
    - `owlette-agent.service` has `KillMode=process` and `WantedBy=graphical.target` (the lab unit's `WantedBy=multi-user.target` + `After=graphical.target` is a silent ordering cycle, L1) [verbatim: T#199, T#288].
    - `owlette-desktop.service` has `ConditionGroup=owlette`, is enabled per kiosk user, and must not carry `Restart=always` [verbatim: decision 4; W4:4.2r2].
    - Sleep disabled (`systemctl mask sleep.target …`) [verbatim: decision 4]. `dbus-user-session` may become a dependency [verbatim: H §15 Task 0.4].
    - The self-update runs `apt-get install --simulate`, then `systemd-run … apt-get install -y` [verbatim: H §15 Task 3.4].
  - Done when / Depends on: [unknown]
  - Status (reconstructed): **NOT STARTED**. The `.deb` bundle config exists only in 4.1's on-disk `tauri.conf.json` (`linux.deb.depends`) [D].

- [ ] **Task 5.3: release workflow restructure**  **[verbatim: H §15]**
  - Files: `.github/workflows/build-installer.yml`
  - Do: three build jobs (`build-windows`, `build-macos`, `build-linux`), each signing/notarizing/stapling its own artifact before emitting a digest; one `digest-and-release` job that downloads all three and loops the `"<hex>␣␣<filename>"` construction at `:139-164` over n subjects; raise only the macOS job's `timeout-minutes` per spike 0.6. Keep the SLSA generator pinned by tag (`:190-192`). Windows signing is unchanged — still unsigned (`build-installer.yml:17`) until the Azure Artifact Signing work is funded; only the macOS leg signs/notarizes/staples in this task. zizmor conventions on every new job.
  - Done when: a tagged release produces three artifacts and `slsa-verifier >= v2.7.0` passes on each.
  - Depends on: 5.1, 5.2.
  - Status (reconstructed): **NOT STARTED**. The owner asked "does this add the linux build into our release workflow/pipeline?" [verbatim: T#282]. The answer given is [unknown]; per the plan, not until 5.2/5.3.

- [ ] **Task 5.4, 5.5**: [unknown]
- [ ] **Task 5.6: dev deploy hook on the new layout** [title inferred]
  - Do: "hook mirrors by relative path" [verbatim: T#2]. The `.claude/hooks/deploy-agent.mjs` hook flattens `agent/src` by basename and cannot mirror `osadapter/` [verbatim: T#2]. Relates to Q9.
  - Status (reconstructed): **NOT STARTED** [inferred]. Note: CLAUDE.md forbids editing `.claude/hooks/` without an explicit request.

---

## Wave 6 — web and dashboard surface, docs

Known: 6.1 and 6.4 [verbatim: H §14 C3 "this plan's 6.1"; H §8 item 16 "Task 6.4 documents it"]. Other tasks [unknown].

- [ ] **Task 6.1: heartbeat `osFamily` / `osVersion` / `arch` + `capabilities.screenCapture|packageInstall|temps`** [title inferred]
  - Do: decision 6 + C3 (normalisation table, separate dotted capability keys, absent means windows) [verbatim: H §13–14].
  - Status (reconstructed): **PARTIAL, pushed as a side feature.** `f56487b8` writes `osFamily`, `arch` and `osVersion` at registration and in the heartbeat merge, computed once, and shows the OS on the machine card and list. It was an owner request, run as workflow `tri-platform-os-identity` [verbatim: C:f56487b8; T#327, T#332]. The `capabilities.*` keys are not in that commit [inferred: C:f56487b8 file list].
- [ ] **Task 6.4: installation docs** [title inferred]
  - Do (fragments): the POSIX preseed (`pairing.json` / `OWLETTE_ADD`) [verbatim: H §15 Task 3.7]; "GDM/LightDM/SDDM login session required; a bare startx session is not a seat" (Q24) [verbatim: T#269]; standard users can switch off background items without MDM [verbatim: H §15 Task 5.1]; an optional MDM section (Q-M3) [verbatim: H §16.6].
  - Status: **NOT STARTED** [inferred].
- Wave 6 items recorded by the Wave 3b log: `metrics.diskio` is `{}` on POSIX (item n); a web surface for Q23 if ruled [verbatim: T#103].

## Wave 7 — [unknown]

No surviving reference names a Wave 7 task.

## Wave 8 — swoop streamer backends on macOS/Linux

- Decision 23 [verbatim: H §13]: +2,825 firm, up to 3,825 lines. Depends on the job runner (4.3), bundle signing (5.1) and packaging; `capabilities.swoop` is ANDed with `streamer_capable()`. Task list [unknown]. Status: **NOT STARTED**.

---

## Wave 4 status at 11:12 PM, 2026-09-16 (reconstructed)

[inferred: D, I, W4:J, W4:4.2r2, W4:4.5, W4:4.7, T#336–343, unless tagged otherwise]

| task | lane | state at 23:12 | on GitHub? | at risk |
|---|---|---|---|---|
| 4.1 | w4a (ported to w4b) | implemented | **no** | yes, both lanes |
| 4.2 | w4b | implemented, VM-verified by the implementer, in adversarial review (round 2 queued) | **no** | yes |
| 4.3 | w4a | implemented; the orchestrator was running a fix/verify harness in WSL (`w43fix`) | **no** | yes, and any WSL-only fix is already lost |
| 4.4 | — | not started (depends on spikes 0.2/0.3) | — | — |
| 4.5 | w4b | implementer queued or just started; no file changes | — | — |
| 4.6 | — | not started | — | — |
| 4.7 | w4b | implementer queued or just started; no file changes | — | — |

**The incident itself** [verbatim: I]: at 23:12:00 the orchestrator's Bash call (PID 62452 → 54200) wrote `w43fix/02-test.sh` and then ran `rm -rf "$(cygpath -u 'C:\')"`, which Git Bash expanded to `rm -rf /c/` (`rm.exe` PID 18248). It ran for about 35 minutes. The same line then ran a WSL-side `rm -rf /var/lib/owlette` reset, so the Windows-side `rm` was probably a mangled attempt at a cleanup [inferred; the intent is not recorded]. Agents that started after it failed at 23:17 with "Not logged in" [verbatim: W4:J].

**Files that exist only on disk** [D, compared with `diff -r --strip-trailing-cr` against `4a3de0cd`; neither lane touches `agent/`, `web/` or `dev/handoff/`]:

- `Owlette-wt-tri-w4a`:
  - `desktop/src/components/StatusFooter.tsx`, `desktop/src/lib/ipc.ts`
  - `desktop/src-tauri/Cargo.toml`, `Cargo.lock`, `tauri.conf.json`
  - `desktop/src-tauri/src/{commands,json_io,lib,paths,shell_open,tray,watchers}.rs`
  - **new** `desktop/src-tauri/src/jobrunner.rs`
- `Owlette-wt-tri-w4b`:
  - `desktop/src/components/StatusFooter.tsx`, `desktop/src/lib/ipc.ts`
  - `desktop/src-tauri/Cargo.toml`, `Cargo.lock`, `tauri.conf.json`
  - `desktop/src-tauri/src/{commands,paths,process_ctl,service_ctl,shell_open,startup_link,tray}.rs`
- Shared by the two lanes (the 4.1 port): `StatusFooter.tsx`, `tauri.conf.json` and `shell_open.rs` are identical. `paths.rs`, `tray.rs`, `commands.rs`, `ipc.ts` and `Cargo.toml` differ, because each lane layered its own task on 4.1, and they will need a three-way merge [D].
- Rescue copies: `C:\Users\admin\Documents\rm-rescue\worktrees\Owlette-wt-tri-{w4a,w4b,l3b}` [verbatim: I].

**VM state at the loss** [verbatim: W4:4.2r2, T#323, T#342]: `owlette-kiosk` is paired to dev and runs under `owlette-agent.service` with managed `lab-xterm` and `lab-sleep`. The lab polkit rule is removed and `/tmp/owlette-ctl-probe` is left in place. The desktop app itself was never deployed.

**Lost with WSL** [inferred: task brief, T#341]: the Tauri Linux toolchain (`/root/.cargo`, Node 22, GTK/WebKit dev libs), `/root/owlette-desktop-probe`, the lane build copies (`/root/<lane>/`, `/root/w4b-probe`, `/root/w43fix`), `/root/venv-owlette`, and the WSL `kiosk` user and `owlette` group used by the Linux gate.

---

## Log

Newest first in the original [verbatim: T#80]. Only entries with surviving evidence are reconstructed.

### 2026-09-16 (evening) — Wave 4 started; macOS 3.2 landed from the Mac [reconstructed; no original entry is known to have been written]

- Mac lane (`feat/tri-platform-macos`, base `4a3de0cd`), in order: `6f0a71eb`, `99aa37ef`, `9d6473a2`, `57802bce`, `4b7618e5`, `f9fb62c7`, `ea7b8d1a`, `bfedc535`, `c2415865`, `8732260d` [verbatim: C:*, HL]. Findings the Mac passed to the orchestrator [verbatim: HL]:
  - Deployment uninstalls fail on every OS: `/api/sites/{siteId}/deployments/{id}/uninstall` sends neither software name nor uninstall command.
  - The Linux branch of `uninstall_software` still dies on `import registry_utils` (winreg).
  - `TestPosix::test_a_capture_the_app_refuses_leaves_nothing_behind` flaked once in 16 full runs (a `_FakeJobRunner` race).
- On `feat/tri-platform-agent`: `f56487b8` (OS on the machine card and list, 20:42) [verbatim: C:f56487b8].
- Wave 4 launched in lanes `w4a`/`w4b` (see the Wave 4 status above).

### 2026-09-16 — crash-alert and handoff-refresh lanes [reconstructed]

- Workflow `wf_aea2f4e7-bac` (6 agents) [verbatim: T#304]:
  - `9fa1e069`: no process_crash event, alert, cortex event or screenshot when a managed app dies while no seat is present. It opens the seatless episode, and a death with the seat present keeps the full path. Negative controls were proven. Windows 1585/204; Linux 1500/132 + IMPORT OK.
  - `4a3de0cd`: the handoff was refreshed for the merged Linux lane.
- VM demo: the merged tree was deployed and paired to dev with the phrase the owner supplied. Health probe ok, heartbeats landing, a managed xterm on seat0 [verbatim: T#323].
  - Owner notes from the demo: `pynvml` logs a WARNING every metrics tick on non-NVIDIA Linux, and the dev agent token cannot `batchWrite`, so writes fall back to individual calls [verbatim: T#323].

### 2026-09-16 — Wave 3b pushed and merged [reconstructed]

- Pre-commit review workflow `wf_e25cc885-ef4` (hygiene lens + VM scripts) [verbatim: T#229]. Commits `fc330739` and `8933a77c`; CI fixes `21ad3fea` and `331de627`; waivers `dd7b5106` [verbatim: C:*]. PR #167 merged into `feat/tri-platform-agent` as `47e5cae0` [verbatim: C:47e5cae0].
- The tasks.md tail recorded: **Owner 2026-09-16: "yes merge to tri-platform-agent"; Q24 ruled keep-as-is** (startx kiosks unsupported; documented by 6.4). Waivers for 359/360/361/363/364 were added to `.github/security-acks.json` (`dd7b5106`; assessed, by design, expiring 2027-03-16), and the alerts dismissed as won't-fix. The crash-alert-on-logout item (y) stayed open, recommended yes, as the first item of the next POSIX round [verbatim: T#269].

### 2026-09-16 — execution session 2 (Wave 3b, the Linux lane, no commits) [original title verbatim: T#80; body reconstructed from T#77, T#80, T#103, T#105, T#166, T#169, T#199, T#202]

- **Lane design**: one worktree `../Owlette-wt-tri-l3b` detached at `62686311`. Tasks ran sequentially 3.1 → 3.2 → 3.4 → 3.7, each through an opus implementer → two adversarial read-only reviewers (correctness, conformance) → fixer → a second correctness review → fixer. 24 agents, 0 errors, about 7.2 h wall clock (workflow `wf_6de657b1-423`) [verbatim: T#77].
- **Linux host**: WSL2 Ubuntu 24.04 as root, `/root/venv-owlette`, no graphical seat [verbatim: T#77].
- **Suite trajectory**: Windows 1489/5 → 1559 passed / 155 skipped. Linux went from 955 passed / 1 failed with 18 ignores to 1427 passed / 130 skipped with the four display ignores, and the three-import smoke passed on Linux for the first time [verbatim: T#77].
- **Port**: 44 files copied byte-identical into `Owlette-wt-tri-linux` (`feat/tri-platform-linux`, uncommitted); the gates re-ran green [verbatim: T#77].
- **Owner items (a)–(f)** [verbatim: T#77]:
  - (a) the macOS CI leg hazard: tests that monkeypatch `osadapter.console_user` error with no darwin.py. Closed 2026-09-16 by the conftest gate [verbatim: T#105].
  - (b) Wave 4 (4.7) must use the seam's restart verb on POSIX and remove `<id>.result` only after the terminal event.
  - (c) the seam's pair verb depends on 5.2's `KillMode=process`.
  - (d) refused POSIX self-update reporting (Q23).
  - (e) a latent Windows-only `_terminate_processes_for_install` basename bug.
  - (f) VM-only verification owed.
- **Close review (2026-09-16, workflow wf_46cc07e6-155)** [verbatim: T#103, T#105]:
  - Six agents across three lenses.
  - Highs:
    - the macos-15 leg going red on about 62 tests that resolve an operation through `__getattr__` → `get()` with no darwin arm;
    - a plantable `<name>.tmp` that made a live kiosk-to-root overwrite-and-regrant primitive.
  - Mediums:
    - a FIFO at `<id>.result` wedging the drain;
    - `console_user()` lacking the startx fallback (→ Q24);
    - an unbounded `privileged_requests.log`;
    - Linux-only metric arms under a POSIX name;
    - `launch_desktop_app_as_user` reachable on POSIX with a hardcoded `.exe`.
  - Applied:
    - the conftest `needs_os_arm`/`os_arm` gate (macos-15 simulation on WSL: 13 failed + 52 errors → 3 failed, all `@linux_only`);
    - `open_new_file()`;
    - reply `O_NONBLOCK`;
    - a mode-refusal answer;
    - audit-log rotation with a 64 KiB tail;
    - a hardened preseed read;
    - real macOS metric arms;
    - the `launch_desktop_app_as_user` guard;
    - the two missing Done-when tests;
    - r2: two ungated WMI probes gated.
  - Rejected:
    - the startx fallback (owner decision);
    - resetting `relaunch_attempts` (pre-existing);
    - folding `linux._run` / one shared `open_regular()` (import layering);
    - `__getattr__` returning a raising callable (breaks the sealed contract test);
    - gating `run_python` (breaks 3.5's partition invariants).
  - Gates: Windows 1566/163/0; Linux 1442/130/0 + IMPORT OK. The wave is CLOSED on this rig.
- **Owner items (g)–(u)** [verbatim: T#103]:
  - (g) Q24.
  - (h) Q23 reworded.
  - (i) the POSIX self-update releases the slow-command lane.
  - (j) Windows behaviour riding along: the 60 s countdown; the marker written before the download.
  - (k) the pair verb has no rate limit and re-pairs a paired machine.
  - (l) `pairing.json.used` persists in the group-readable config dir (accepted risk).
  - (m) `/etc/machine-id` is world-readable (parity with MachineGuid, accepted).
  - (n) `metrics.diskio` is `{}` on POSIX (Wave 6).
  - (o) `pending_reboot()` / `streamer_capable()` have no production caller.
  - (p) `tools_posix.manage_windows_service` does no unit mapping.
  - (q) a failed restart/reboot still burns the five-minute window.
  - (r) `tray.rs` writes `tmp/restart.flag`; 4.7 must use `ipc/requests`.
  - (s) a stale `_capture_crash_screenshot` docstring.
  - (t) 3.7 plan-text correction.
  - (u) the VM-only Done-when list.
- **VM verification (2026-09-16, golden kiosk `owlette-kiosk`)** [verbatim: T#169]:
  - PASS: the mode table 15/15; the seat on X11 and Wayland with the typed Wayland capture refusal; a root main loop with a real relaunch; a scheduled reboot firing and cancelling; 7/7 seam scenarios; `KillMode=process` survival with its negative control; the apt transient-unit install and the missing-`Depends:` refusal.
  - BLOCKED: a real `.deb`, `_consume_preseed`, `restart` against a live unit, Wave 4's app.
  - Defects:
    - D1 HIGH: `session_env` read the root PAM worker, so no DISPLAY and `USER=root`.
    - D2 MEDIUM: scout launched every tick.
    - D3 LOW: a third ungated display import.
    - O4 LOW: backslash-folded exe paths.
    - O5 MEDIUM: relaunch budget unenforceable without the app.
    - D6 HIGH: `console_user()` answered `gdm` at the greeter.
- **VM-defect fix rounds (three workflows `wf_dd77e3ad-e5f`, `wf_9e3c722e-6ae`, `wf_449f8b9f-6fa`; 12 agents, 0 errors)** [verbatim: T#166, T#169]:
  - The three-rung in-session `session_env`, `Class=user`, the scout and sentinel gates, `normalize_exe_path`, escalation without a prompt, the seatless rule at the choke point, the loop-thread seat memo, and quieter greeter noise.
  - Accepted residue (a)–(j).
  - Gates: Windows 1579/194/0; Linux 1484/132/0; 43 modified + 4 new files, +6,871/−992 lines vs `62686311`.
- **VM re-verification (vm-verify-2026-09-16-rerun.md)** [verbatim: T#202]: eleven checks PASS; D1/D2/D3/O4/O5 fixed. New observations: O1 byte-identical rewrites, O2 a logout burning the budget (logind `Active` through a 90 s scope stop), O3 the seat-return launch booked as attempt 1, and L1 the lab unit ordering cycle.
- **Observation fix round (workflow wf_7cc7114f-06b, 4 agents)** [verbatim: T#202]:
  - O2: the `State ∈ {active, online}` filter; the teardown window was measured instead of heuristically decayed (26.6 ms / 4.8 ms, 0/774 and 0/768 samples).
  - O3: the post-seatless launch is a first launch.
  - O1: a byte-identical skip.
  - Gates: Windows 1582/200/0; Linux 1493/132/0.
- **Coverage round (wf_67ca05b5-a56)** [verbatim: T#209]:
  - T1: a crash-loop control with real pids.
  - T2: the seatless episode neither spends nor clears the budget.
  - T3: `opening` pinned as not a seat.
  - T4: comment fix.
  - Mutations were proven red.
  - The original sentence "pending - appended by the orchestrator" was to be replaced; its final wording is [unknown].
- **Owner items (v)–(aa)** [verbatim: T#169, T#199, T#202]:
  - (v) startx → Q24.
  - (w) `postinst` must not run `--preseed` synchronously.
  - (x) pass the resolved session into `launch_managed_process`.
  - (y) crash alert on logout → ruled yes, `9fa1e069`.
  - (z) 5.2's unit `WantedBy=graphical.target`.
  - (aa) the VM left in the lab state; restore `golden-20260916` before other use.

### 2026-09-15 — execution session 1 (Waves 0–3, Windows-verifiable half) [reconstructed from C:6ef1b057, T#2]

- Every task went through one implementer, two adversarial reviewers with fix rounds, and a three-lens close review per wave. Gates: pytest 1489 passed / 5 skipped; jest 5168 (5185 per T#2); tsc, eslint, vitest (489), cargo (109) and zizmor clean [verbatim: C:6ef1b057; T#2].
- Lanes were ported with a majority-vote port across lane copies and `git merge-file` three-way merges with CRLF normalisation [verbatim: T#2].
- Committed and pushed as PR #150: `6ef1b057`, a merge of 40 dev commits (`7f8d6ae6`), `3cc6e8cc` (macOS handoff), `9e1905cc` and `62686311` (CI round fixes and waivers) [verbatim: T#2].
- Owner rulings: Q19 keep, Q20 hold. Q22 raised [verbatim: T#2].
- The WSL2 Ubuntu 24.04 rig was set up and the Hyper-V VM `owlette-kiosk` built (scripts `scripts/vm/ubuntu/01-06`, later `8933a77c`); golden checkpoint `golden-20260916` [verbatim: T#2, T#23].
